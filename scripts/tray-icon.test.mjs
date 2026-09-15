import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTrayBitmap, getTrayIconState } from '../src/main/services/tray-icon.ts'
import { normalizeSettings } from '../src/shared/capsule.ts'

test('display mode survives saved settings and accepts older settings without a mode', () => {
  for (const displayMode of ['floating', 'tray']) {
    const saved = JSON.parse(JSON.stringify(normalizeSettings({ displayMode })))
    assert.equal(normalizeSettings(saved).displayMode, displayMode)
  }
  assert.equal(normalizeSettings({}).displayMode, 'tray')
  assert.equal(normalizeSettings({ displayMode: 'invalid' }).displayMode, 'tray')
})

test('tray preserves the weekly quota, percentage mode and stale/reset states', () => {
  const now = Date.parse('2026-09-15T00:00:00Z')
  const settings = { percentageMode: 'remaining', refreshIntervalSeconds: 30 }
  const weekly = { label: '7d', remainingPercent: 80, usedPercent: 20 }
  const snapshot = {
    rateLimitSource: 'official',
    lastSuccessAt: new Date(now).toISOString(),
    rateLimits: [{ label: '5h', remainingPercent: 10, usedPercent: 90 }, weekly]
  }
  assert.deepEqual(getTrayIconState(snapshot, settings, now), { text: '80', color: '#166534' })
  assert.deepEqual(getTrayIconState(snapshot, { ...settings, percentageMode: 'used' }, now), {
    text: '20', color: '#166534'
  })
  assert.equal(getTrayIconState({ ...snapshot, rateLimitSource: 'cache' }, settings, now).color, '#475569')
  assert.equal(getTrayIconState(snapshot, settings, now + 91000).color, '#475569')
  weekly.resetsAt = new Date(now).toISOString()
  assert.equal(getTrayIconState(snapshot, settings, now).text, '--')
  assert.equal(getTrayIconState({ ...snapshot, rateLimits: [] }, settings, now).text, '--')
  for (const text of ['0', '80', '100', '--']) {
    const bitmap = createTrayBitmap(text, '#166534')
    assert.equal(bitmap.length, 32 * 32 * 4)
    assert.deepEqual([...bitmap.subarray(0, 4)], [0x34, 0x65, 0x16, 255])
    assert.ok(bitmap.includes(Buffer.from([255, 255, 255, 255])))
  }
})
