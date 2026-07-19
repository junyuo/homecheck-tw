import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pagesBase } from './src/config/site'

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || pagesBase,
})
