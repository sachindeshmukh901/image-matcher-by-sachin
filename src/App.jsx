import { useEffect, useMemo, useRef, useState } from 'react'
import { fingerprint, similarity, faceDistance, MATCH_DISTANCE_THRESHOLD, tierOf, TIERS } from './matcher.js'
import { getAll, addPhoto, updatePhoto, renamePhoto, removePhoto, clearPhotos, requestPersistentStorage } from './db.js'

const nameOf = (f) => f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const MEANING = { exact: 'Very high similarity', strong: 'Strong similarity', weak: 'Possible similarity', none: 'Low similarity' }

function CountUp({ to, suffix = '' }) {
  const [v, setV] = useState(0)
  useEffect(() => {
    let raf, t0
    const tick = (t) => {
      t0 ??= t
      const p = Math.min((t - t0) / 800, 1)
      setV(Math.round(to * (1 - Math.pow(1 - p, 3))))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [to])
  return <>{v}{suffix}</>
}

export default function App() {
  const [db, setDb] = useState([])
  const [target, setTarget] = useState(null)
  const [query, setQuery] = useState('')
  const [phase, setPhase] = useState('idle') // idle | scanning | done
  const [upload, setUpload] = useState(null) // {done,total}
  const [progress, setProgress] = useState(0)
  const [comparedCount, setComparedCount] = useState(0)
  const [current, setCurrent] = useState(null)
  const [results, setResults] = useState([])
  const [tier, setTier] = useState('all')
  const [dragDb, setDragDb] = useState(false)
  const [dragT, setDragT] = useState(false)
  const [error, setError] = useState('')
  const [storageNotice, setStorageNotice] = useState('')
  const addRef = useRef(), folderRef = useRef(), fileRef = useRef()

  // Load saved photos and rebuild old fingerprints using the new face-recognition model.
  useEffect(() => {
    let cancelled = false
    async function loadSavedPhotos() {
      try {
        const rows = await getAll()
        const loaded = []
        for (const row of rows) {
          const url = URL.createObjectURL(row.blob)
          try {
            const fp = await fingerprint(url)
            const updated = { ...row, fp }
            // Update old records, so the database uses facial descriptors going forward.
            await new Promise((resolve) => {
              const request = indexedDB.open('photomatch', 1)
              request.onsuccess = () => {
                const database = request.result
                const transaction = database.transaction('photos', 'readwrite')
                transaction.objectStore('photos').put(updated)
                transaction.oncomplete = () => { database.close(); resolve() }
                transaction.onerror = () => { database.close(); resolve() }
              }
              request.onerror = () => resolve()
            })
            loaded.push({ ...updated, url })
          } catch (err) {
            // Keep records visible even if a face cannot currently be detected.
            loaded.push({ ...row, url, fp: null, faceError: err.message })
          }
        }
        if (!cancelled) setDb(loaded)
      } catch (err) {
        if (!cancelled) setError('Could not load saved photos from this browser.')
      }
    }
    loadSavedPhotos()
    return () => { cancelled = true }
  }, [])

  const pool = useMemo(() => db.filter((d) => d.name.toLowerCase().includes(query.toLowerCase())), [db, query])

  async function addFiles(fileList) {
    const imgs = [...fileList].filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    setError('')
    try {
      const persistent = await requestPersistentStorage()
      setStorageNotice(persistent
        ? 'Protected browser storage is enabled. Photos stay on this device unless site data is cleared.'
        : 'Photos are saved in this browser and survive refreshes, but browser cleanup may remove them.')
    } catch (err) {
      setStorageNotice('Photos are saved in this browser, but protected storage could not be enabled.')
      setError(`Could not enable protected browser storage: ${err.message || 'the browser did not provide more details.'}`)
    }
    setUpload({ done: 0, total: imgs.length })
    for (let i = 0; i < imgs.length; i++) {
      const url = URL.createObjectURL(imgs[i])
      try {
        const name = nameOf(imgs[i])
        const id = await addPhoto({ name, blob: imgs[i], fp: null })
        const photo = { id, name, blob: imgs[i], fp: null, url }
        setDb((p) => [...p, photo])
        try {
          const fp = await fingerprint(url)
          const updated = { ...photo, fp }
          await updatePhoto(updated)
          setDb((p) => p.map((item) => item.id === id ? updated : item))
        } catch (err) {
          setError(`${imgs[i].name}: Saved to your library, but face processing failed. ${err.message || 'You can retry this photo later.'}`)
        }
      } catch (err) {
        URL.revokeObjectURL(url)
        setError(`${imgs[i].name}: Could not save this photo to your library. ${err.message || ''}`)
      }
      setUpload({ done: i + 1, total: imgs.length })
    }
    setTimeout(() => setUpload(null), 700)
  }

  const rename = (id, name) => setDb((p) => p.map((d) => (d.id === id ? { ...d, name } : d)))
  const remove = async (id) => { await removePhoto(id); setDb((p) => p.filter((d) => d.id !== id)) }
  const clearAll = async () => { if (confirm('Delete all photos from the database?')) { await clearPhotos(); setDb([]); setResults([]); setPhase('idle') } }

  async function loadTarget(file) {
    if (!file || !file.type.startsWith('image/')) return
    setError('')
    const url = URL.createObjectURL(file)
    try {
      const fp = await fingerprint(url)
      setTarget({ name: file.name, url, fp })
      setResults([]); setPhase('idle')
    } catch (err) {
      URL.revokeObjectURL(url)
      setTarget(null)
      setError(err.message || 'Could not process this image.')
    }
  }

  async function runMatch() {
    if (!target || !pool.some((photo) => photo.fp?.descriptor)) return
    setError('')
    setPhase('scanning'); setResults([]); setTier('all'); setProgress(0)
    const out = []
    let compared = 0
    const delay = Math.min(60, 2200 / pool.length)
    for (let i = 0; i < pool.length; i++) {
      setCurrent(pool[i])
      if (pool[i].fp?.descriptor) {
        compared++
        const distance = faceDistance(target.fp, pool[i].fp)
        // Only accept a candidate if its face-descriptor distance passes the strict threshold.
        // Other photos are not displayed as matches just because they have a ranked score.
        if (distance <= MATCH_DISTANCE_THRESHOLD) {
          out.push({ ...pool[i], distance, score: similarity(target.fp, pool[i].fp) })
        }
      }
      setProgress(Math.round(((i + 1) / pool.length) * 100))
      await wait(delay)
    }
    out.sort((a, b) => a.distance - b.distance)
    setCurrent(null); setComparedCount(compared); setResults(out); setPhase('done')
    if (!compared) setError('No database photos had a detectable face. Try clearer, front-facing images.')
    setTimeout(() => document.getElementById('results')?.scrollIntoView({ behavior: 'smooth' }), 100)
  }

  const counts = TIERS.map((t) => ({ ...t, n: results.filter((r) => tierOf(r.score).key === t.key).length }))
  const best = results[0]
  const bestTier = best && tierOf(best.score)
  const avg = results.length ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length) : 0
  const shown = results.filter((r) => tier === 'all' || tierOf(r.score).key === tier)

  function exportCsv() {
    const rows = ['person,similarity,result', ...results.map((r) => `"${r.name}",${r.score}%,${tierOf(r.score).name}`)]
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }))
    a.download = 'matching-report.csv'
    a.click()
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand" aria-label="PhotoMatch">
          <span className="logo">
            <svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="13" width="8" height="8" rx="2" /><path d="M13 7h4a2 2 0 0 1 2 2v2M11 17H7a2 2 0 0 1-2-2v-2" /></svg>
          </span>
          <span className="brand-copy">
            <b>PhotoMatch</b>
            <small>SIMILARITY STUDIO</small>
          </span>
        </div>
        <div className="privacy-badge"><span /> Private by design</div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">FACE SEARCH WORKSPACE</span>
          <h1>Find the face<br /><span>in your collection.</span></h1>
          <p>Build a private photo library, then compare a new image against the faces you’ve saved.</p>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-frame"><span className="art-face">✳</span><i /><i /><i /><i /></div>
          <span className="art-spark spark-one">✦</span><span className="art-spark spark-two">✧</span>
        </div>
      </section>

      <section className="dashboard-stats" aria-label="Workspace overview">
        <div className="stat-card">
          <span className="stat-icon collection-icon">▧</span>
          <span><small>PHOTO LIBRARY</small><b>{db.length}</b><em>saved {db.length === 1 ? 'photo' : 'photos'}</em></span>
        </div>
        <div className="stat-card">
          <span className="stat-icon face-icon">◎</span>
          <span><small>READY TO SEARCH</small><b>{db.filter((photo) => photo.fp?.descriptor).length}</b><em>face profiles</em></span>
        </div>
        <div className="stat-card stat-private">
          <span className="stat-icon private-icon">⌑</span>
          <span><small>YOUR PHOTOS</small><b>Stay yours</b><em>stored on this device</em></span>
        </div>
      </section>
      {storageNotice && <p className="storage-note" role="status">{storageNotice}</p>}

      {error && <div className="error-message" role="alert"><b>Notice:</b> {error}<button onClick={() => setError('')} aria-label="Dismiss message">×</button></div>}

      <div className="section-intro">
        <div><span className="eyebrow">YOUR WORKFLOW</span><h2>Three simple steps</h2></div>
        <p>Photos stay in your browser. Nothing is uploaded to a server.</p>
      </div>

      <main className="layout">
        {/* STEP 1 */}
        <section
          className={`card db ${dragDb ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragDb(true) }}
          onDragLeave={() => setDragDb(false)}
          onDrop={(e) => { e.preventDefault(); setDragDb(false); addFiles(e.dataTransfer.files) }}
        >
          <div className="head">
            <span className="step">01</span>
            <div><h2>Your photo library</h2><small>Add and organize the photos you want to search</small></div>
          </div>

          <div className="toolbar">
            <label className="search">
              <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search person by name" />
            </label>
            <button className="btn primary" onClick={() => addRef.current.click()}><span aria-hidden="true">＋</span> Add photos</button>
            <button className="btn" onClick={() => folderRef.current.click()}>Add folder</button>
            {db.length > 0 && <button className="btn danger" onClick={clearAll}>Clear all</button>}
          </div>
          <input ref={addRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
          <input ref={folderRef} type="file" multiple webkitdirectory="" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />

          {upload && (
            <div className="uploading">
              Saving {upload.done} of {upload.total}
              <div className="bar"><div style={{ width: (upload.done / upload.total) * 100 + '%' }} /></div>
            </div>
          )}

          {db.length === 0 ? (
            <button className="empty" onClick={() => addRef.current.click()}>
              <svg viewBox="0 0 24 24"><path d="M12 16V5m0 0l-4 4m4-4l4 4M5 19h14" /></svg>
              <b>Your library starts here</b>
              <span>Click here, or drag and drop photos. The file name becomes the person's name.</span>
              <span className="empty-action">Choose photos <span aria-hidden="true">→</span></span>
            </button>
          ) : (
            <div className="tiles">
              {pool.map((d) => (
                <div key={d.id} className={`tile ${current?.id === d.id ? 'hot' : ''}`}>
                  <img src={d.url} alt={d.name} />
                  <button className="x" onClick={() => remove(d.id)} aria-label={`Remove ${d.name}`}>×</button>
                  <input value={d.name} onChange={(e) => rename(d.id, e.target.value)} onBlur={(e) => renamePhoto(d.id, e.target.value)} aria-label="Person name" />
                </div>
              ))}
              {!pool.length && <p className="note">No person found for “{query}”.</p>}
            </div>
          )}
        </section>

        {/* STEP 2 */}
        <section className="card find">
          <div className="head">
            <span className="step">02</span>
            <div><h2>Choose a photo</h2><small>Upload the face you want to find</small></div>
          </div>

          <div
            className={`drop ${dragT ? 'over' : ''}`}
            onClick={() => fileRef.current.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current.click() } }}
            role="button"
            tabIndex={0}
            aria-label="Choose a photo to match"
            onDragOver={(e) => { e.preventDefault(); setDragT(true) }}
            onDragLeave={() => setDragT(false)}
            onDrop={(e) => { e.preventDefault(); setDragT(false); loadTarget(e.dataTransfer.files[0]) }}
          >
            {target ? (
              <div className="preview">
                <img src={target.url} alt="Photo to match" />
                {phase === 'scanning' && <div className="laser" />}
                {phase === 'scanning' && current && <img className="peek" src={current.url} alt="" />}
              </div>
            ) : (
              <div className="hint">
                <svg viewBox="0 0 24 24"><path d="M12 16V5m0 0l-4 4m4-4l4 4M5 19h14" /></svg>
                <b>Drop your photo here</b>
                <span>or browse files on your device</span>
                <span className="drop-formats">JPG · PNG · WEBP</span>
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => loadTarget(e.target.files[0])} />
          {target && phase !== 'scanning' && <button className="link" onClick={() => fileRef.current.click()}>Change photo</button>}

          <button className="btn primary big" disabled={!target || !pool.some((photo) => photo.fp?.descriptor) || phase === 'scanning'} onClick={runMatch}>
            {phase === 'scanning' ? `Comparing… ${progress}%` : <>Find matches <span aria-hidden="true">→</span></>}
          </button>
          {phase === 'scanning' && <div className="bar"><div style={{ width: progress + '%' }} /></div>}
          <p className="note">{!db.length ? 'First add photos to the database.' : !target ? 'Upload a clear photo with one visible face.' : `Will compare with ${pool.filter((photo) => photo.fp?.descriptor).length} face descriptor${pool.filter((photo) => photo.fp?.descriptor).length === 1 ? '' : 's'}.`}</p>
        </section>
      </main>

      {/* STEP 3 */}
      {phase === 'done' && (
        <section className="card report" id="results">
          <div className="head">
            <span className="step">03</span>
            <div><h2>Your matching results</h2><small>{comparedCount} faces compared · {results.length} accepted match{results.length === 1 ? '' : 'es'}</small></div>
            <button className="btn right" onClick={exportCsv}><span aria-hidden="true">↓</span> Download report</button>
          </div>

          {results.length === 0 && <div className="no-match"><strong>No reliable match found</strong><p>None of the saved faces passed the matching threshold. The uploaded face may be a different person, or the photos may have different angles or lighting.</p><small>This is a conservative filter, not a guarantee of identity.</small></div>}

          <div className="summary">
            {best && <div className="versus">
              <figure><img src={target.url} alt="Your photo" /><figcaption>Your photo</figcaption></figure>
              <div className="score" style={{ '--c': bestTier.color }}>
                <strong><CountUp to={best.score} suffix="%" /></strong>
                <span>{MEANING[bestTier.key]}</span>
              </div>
              <figure><img src={best.url} alt={best.name} /><figcaption>Best match: <b>{best.name}</b></figcaption></figure>
            </div>}

            <div className="tiers">
              {counts.map((t) => (
                <button key={t.key} className={`tier ${tier === t.key ? 'on' : ''}`} style={{ '--c': t.color }} onClick={() => setTier(tier === t.key ? 'all' : t.key)}>
                  <span className="chip">{t.label}</span>
                  <span className="what">{MEANING[t.key]}</span>
                  <span className="track"><span style={{ width: (results.length ? (t.n / results.length) * 100 : 0) + '%' }} /></span>
                  <span className="n"><CountUp to={t.n} /></span>
                </button>
              ))}
              <small className="note">Scores are similarity estimates, not proof of identity. Click a row to filter results.</small>
            </div>
          </div>

          <div className="grid">
            {shown.map((r, i) => {
              const t = tierOf(r.score)
              return (
                <article key={r.id} className="res" style={{ '--c': t.color, animationDelay: Math.min(i, 16) * 35 + 'ms' }}>
                  <img src={r.url} alt={r.name} />
                  <div className="info">
                    <b>{r.name}</b>
                    <span className="pct">{r.score}%</span>
                  </div>
                  <div className="meter"><span style={{ width: r.score + '%' }} /></div>
                  <small>{MEANING[t.key]}</small>
                </article>
              )
            })}
            {!shown.length && <p className="note">No photos in this group.</p>}
          </div>
        </section>
      )}
    </div>
  )
}
