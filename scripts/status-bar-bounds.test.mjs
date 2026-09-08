import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { CAPSULE_WINDOW_SIZE, ORB_WINDOW_SIZE } from '../src/shared/capsule.ts'

// node --experimental-strip-types scripts/status-bar-bounds.test.mjs
// 只执行窗口边界函数，避免导入主进程时启动 Electron。
const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const body = source.match(/function setCapsuleBounds\(bounds: Rectangle\): void \{[\s\S]*?\n\}/)?.[0]
assert.ok(body)
const calls = []
const current = { x: 100, y: 100, ...CAPSULE_WINDOW_SIZE }
const applyBounds = new Function(
  'mainWindow',
  ts.transpileModule(body, {}).outputText + '\nreturn setCapsuleBounds'
)({
  isDestroyed: () => false,
  getBounds: () => current,
  setPosition: (...args) => calls.push(['position', ...args]),
  setBounds: (...args) => calls.push(['bounds', ...args])
})

applyBounds(current)
assert.deepEqual(calls, [])
applyBounds({ ...current, x: 0 })
assert.deepEqual(calls.pop(), ['position', 0, 100, false])
const vertical = { x: 0, y: 100, ...ORB_WINDOW_SIZE }
applyBounds(vertical)
assert.deepEqual(calls.pop(), ['bounds', vertical, false])
assert.equal(vertical.width, current.height)
assert.equal(vertical.height, current.width)
