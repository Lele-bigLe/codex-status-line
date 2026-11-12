import { resolve } from 'path'
import { defineConfig, mergeConfig } from 'vite'
import renderer from './vite.renderer.config'

export default defineConfig(
  mergeConfig(renderer, {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    clearScreen: false,
    plugins: [
      {
        name: 'tauri-content-security-policy',
        // Tauri 注入 tauri.conf.json 中的策略；HTML 的 Electron 策略会额外拦截 IPC。
        transformIndexHtml(html: string) {
          return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '')
        }
      }
    ],
    server: {
      host: '127.0.0.1',
      port: 1420,
      strictPort: true
    },
    build: {
      outDir: resolve(__dirname, 'out/tauri-renderer'),
      emptyOutDir: true
    }
  })
)
