import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' makes the built site work on GitHub Pages under any repo name
export default defineConfig({ plugins: [react()], base: './' })
