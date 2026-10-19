import * as faceapi from '@vladmandic/face-api'

// Face-recognition models are loaded once and cached by the browser.
// Models are served from the project's public model repository via jsDelivr.
const MODEL_URL = 'https://cdn.jsdelivr.net/gh/vladmandic/face-api/model'
let modelsPromise

async function loadModels() {
  if (!modelsPromise) {
    modelsPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]).catch((error) => {
      modelsPromise = null
      throw new Error('Could not load the face-recognition models. Check your internet connection and reload the page.')
    })
  }
  await modelsPromise
}

const loadImage = (url) => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = () => reject(new Error('This image could not be opened. Please choose another image.'))
  image.src = url
})

/** Returns a 128-number facial descriptor, not a colour/whole-image fingerprint. */
export async function fingerprint(url) {
  await loadModels()
  const image = await loadImage(url)
  const result = await faceapi
    .detectSingleFace(image, new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.15 }))
    .withFaceLandmarks()
    .withFaceDescriptor()

  if (!result) {
    throw new Error('No clear face was detected. Use a front-facing photo with the face visible and well lit.')
  }
  return { descriptor: Array.from(result.descriptor) }
}

/** Euclidean distance between two face descriptors. Lower means more similar. */
export function faceDistance(a, b) {
  if (!a?.descriptor?.length || !b?.descriptor?.length || a.descriptor.length !== b.descriptor.length) {
    return Number.POSITIVE_INFINITY
  }
  let sum = 0
  for (let i = 0; i < a.descriptor.length; i++) {
    const delta = a.descriptor[i] - b.descriptor[i]
    sum += delta * delta
  }
  return Math.sqrt(sum)
}

/**
 * Display-only score. This is NOT a probability that two photos show the same person.
 * Use faceDistance + MATCH_DISTANCE_THRESHOLD to decide whether to accept a match.
 */
export function similarity(a, b) {
  const distance = faceDistance(a, b)
  if (!Number.isFinite(distance)) return 0
  return Math.max(0, Math.min(100, Math.round(100 - (distance / 0.6) * 50)))
}

// Common starting threshold for face-api descriptor distance. Validate with real images.
// Lower distance means a closer descriptor match; a high score alone is not proof of identity.
export const MATCH_DISTANCE_THRESHOLD = 0.6

export const TIERS = [
  { key: 'exact', label: '90%+', name: 'Very high similarity', min: 90, color: 'var(--exact)' },
  { key: 'strong', label: '60%+', name: 'Strong similarity', min: 60, color: 'var(--strong)' },
  { key: 'weak', label: '30%+', name: 'Possible similarity', min: 30, color: 'var(--weak)' },
  { key: 'none', label: 'Low', name: 'Low similarity', min: 0, color: 'var(--none)' },
]
export const tierOf = (score) => TIERS.find((tier) => score >= tier.min) || TIERS[TIERS.length - 1]
