import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldRecheckOfficialRateLimits } from '../src/main/services/quota.ts'

function rateLimits(primary, secondary) {
  return {
    primary: { id: 'primary', label: '5h', usedPercent: primary },
    secondary: { id: 'secondary', label: '7d', usedPercent: secondary }
  }
}

test('仅在两个官方窗口同时下降时复查', () => {
  const local = rateLimits(61, 10)

  assert.equal(shouldRecheckOfficialRateLimits(rateLimits(4, 1), local), true)
  assert.equal(shouldRecheckOfficialRateLimits(rateLimits(0, 0), local), true)
  assert.equal(shouldRecheckOfficialRateLimits(rateLimits(62, 10), local), false)
  assert.equal(shouldRecheckOfficialRateLimits(rateLimits(0, 10), local), false)
})
