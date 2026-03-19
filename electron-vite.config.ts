import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

// Read package.json to get all dependency names for externalization
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
const allDeps = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {})
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['electron', ...allDeps, /^node:/]
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: './src/renderer/index.html'
      }
    }
  }
})
