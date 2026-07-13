import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseOfficialDispatchResetAt,
  parseOfficialRateLimits,
  shouldRecheckOfficialRateLimits
} from '../src/main/services/quota.ts'

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

test('按官方实际窗口解析计时状态', () => {
  assert.equal(
    parseOfficialDispatchResetAt({ rate_limit: { secondary_window: { reset_at: 123 } } }),
    123
  )
  assert.equal(parseOfficialDispatchResetAt({ rate_limit: {} }), null)
  assert.equal(parseOfficialDispatchResetAt({}), undefined)

  const rateLimits = parseOfficialRateLimits(
    { rate_limit: { secondary_window: { used_percent: 20 } } },
    new Date('2026-07-13T00:00:00Z')
  )
  assert.equal(rateLimits.primary, undefined)
  assert.equal(rateLimits.secondary?.usedPercent, 20)
})
