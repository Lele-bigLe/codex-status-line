import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTs } from './load-ts.mjs'

const { normalizeSettings, selectPrimaryRateLimit } = await import(
  loadTs(new URL('../src/shared/capsule.ts', import.meta.url))
)
const { createTrayBitmap, getTrayIconState } = await import(
  loadTs(new URL('../src/main/services/tray-icon.ts', import.meta.url))
)

test('display mode survives saved settings and accepts older settings without a mode', () => {
  for (const displayMode of ['floating', 'tray']) {
    const saved = JSON.parse(JSON.stringify(normalizeSettings({ displayMode })))
    assert.equal(normalizeSettings(saved).displayMode, displayMode)
  }
  assert.equal(normalizeSettings({}).displayMode, 'tray')
  assert.equal(normalizeSettings({ displayMode: 'invalid' }).displayMode, 'tray')
})

test('primary quota prefers 5h, then 7d, and supports other or absent windows', () => {
  const short = { label: '5h' }
  const weekly = { label: '7d' }
  const other = { label: '1d', windowMinutes: 1440 }
  assert.equal(selectPrimaryRateLimit([weekly, short]), short)
  assert.equal(selectPrimaryRateLimit([short]), short)
  assert.equal(selectPrimaryRateLimit([other, weekly]), weekly)
  assert.equal(selectPrimaryRateLimit([weekly]), weekly)
  assert.equal(selectPrimaryRateLimit([other]), other)
  assert.equal(selectPrimaryRateLimit([]), undefined)
  const shortByDuration = { label: 'primary', windowMinutes: 300 }
  const weekByDuration = { label: 'secondary', windowMinutes: 10080 }
  assert.equal(selectPrimaryRateLimit([weekByDuration, shortByDuration]), shortByDuration)
  assert.equal(selectPrimaryRateLimit([other, weekByDuration]), weekByDuration)
})

test('tray preserves the selected quota, percentage mode and stale/reset states', () => {
  const now = Date.parse('2026-09-15T00:00:00Z')
  const settings = { percentageMode: 'remaining', refreshIntervalSeconds: 30 }
  const weekly = { label: '7d', remainingPercent: 80, usedPercent: 20 }
  const short = { label: '5h', remainingPercent: 10, usedPercent: 90 }
  const snapshot = {
    rateLimitSource: 'official',
    lastSuccessAt: new Date(now).toISOString(),
    rateLimits: [weekly, short]
  }
  assert.deepEqual(getTrayIconState(snapshot, settings, now), { text: '10', color: '#b91c1c' })
  assert.deepEqual(getTrayIconState({ ...snapshot, rateLimits: [weekly] }, settings, now), {
    text: '80',
    color: '#166534'
  })
  assert.deepEqual(getTrayIconState(snapshot, { ...settings, percentageMode: 'used' }, now), {
    text: '90',
    color: '#b91c1c'
  })
  assert.equal(
    getTrayIconState({ ...snapshot, rateLimitSource: 'cache' }, settings, now).color,
    '#475569'
  )
  assert.equal(getTrayIconState(snapshot, settings, now + 91000).color, '#475569')
  short.resetsAt = new Date(now).toISOString()
  assert.equal(getTrayIconState(snapshot, settings, now).text, '--')
  assert.equal(getTrayIconState({ ...snapshot, rateLimits: [] }, settings, now).text, '--')
  for (const text of ['0', '80', '100', '--']) {
    const bitmap = createTrayBitmap(text, '#166534')
    assert.equal(bitmap.length, 32 * 32 * 4)
    assert.deepEqual([...bitmap.subarray(0, 4)], [0x34, 0x65, 0x16, 255])
    assert.ok(bitmap.includes(Buffer.from([255, 255, 255, 255])))
  }
})
