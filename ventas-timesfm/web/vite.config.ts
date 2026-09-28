import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// El backend FastAPI corre en :8000; Vite le reenvía /api.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
