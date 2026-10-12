import { defineConfig } from 'vite'

// TAURI_ENV_PLATFORM is set when vite is started by the tauri cli
export default defineConfig({
  base: './',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM ? 'safari15' : 'es2022'
  }
})
