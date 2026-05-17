import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Публічний URL ресурсів. На Vercel лишіть порожнім (корінь `/`). Для GitHub Pages: `/avkPallet/`. */
function publicBase(): string {
  const raw = process.env.VITE_BASE?.trim()
  if (!raw || raw === '/') return '/'
  return raw.endsWith('/') ? raw : `${raw}/`
}

// https://vite.dev/config/
export default defineConfig({
  base: publicBase(),
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
})
