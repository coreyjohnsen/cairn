// The phone and tablet companion: a separate web app that Cairn serves to paired devices (built to out/remote).
//   npm run build:remote   build it         npm run dev:remote   design it in a browser with the demo backend
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(__dirname, 'src/remote'),
  base: './',
  publicDir: resolve(__dirname, 'src/remote/public'),
  // The companion reuses the interface's stores and chat components, so `@` is the desktop interface's source folder.
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@': resolve(__dirname, 'src/renderer/src') } },
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'out/remote'),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: { input: { index: resolve(__dirname, 'src/remote/index.html') } }
  },
  // Point at a running Cairn to try the real thing: REMOTE_HOST=http://127.0.0.1:8742 npm run dev:remote
  server: { host: '127.0.0.1', port: 5174, strictPort: true, proxy: process.env.REMOTE_HOST ? { '/remote': { target: process.env.REMOTE_HOST, changeOrigin: false } } : undefined }
})
