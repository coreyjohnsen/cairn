// Browser-only dev server for designing and screenshotting the interface with the in-memory demo backend.
// Run with: npm run dev:web   (the real app uses electron.vite.config.ts)
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@': resolve(__dirname, 'src/renderer/src') } },
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true }
})
