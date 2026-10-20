import { defineConfig } from 'electron-vite'
import renderer from './vite.renderer.config'

export default defineConfig({
  main: {},
  preload: {},
  renderer
})
