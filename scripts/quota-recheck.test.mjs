import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import https from 'node:https'
import {
  areOfficialDispatchResetAtsStable,
  parseOfficialDispatchResetAts,
  parseOfficialRateLimits,
  parseCodexCredentials,
  selectCachedSnapshot,
  collectUsageSnapshot,
  clearQuotaCache
} from '../src/main/services/quota.ts'

const observedAt = new Date('2026-09-07T00:00:00Z')

test('续期保留同账号历史结果,请求期间切号或退出不会复用旧额度', async (t) => {
  const authFor = (account, revision) => ({
    auth_mode: 'chatgpt',
    tokens: {
      account_id: account,
      access_token: `header.${Buffer.from(JSON.stringify({ sub: account, revision })).toString('base64url')}.signature`
    }
  })
  let auth = authFor('account-a', 1)
  let usedPercent = 42
  let networkFails = false
  let beforeResponse = () => {}
  clearQuotaCache()
  t.after(clearQuotaCache)
  t.mock.method(fs, 'readFile', async () => JSON.stringify(auth))
  // 只模拟 HTTP 与凭据文件边界,运行真实的采集、身份校验和缓存流程。
  t.mock.method(https, 'request', (_url, _options, onResponse) => {
    const request = new EventEmitter()
    request.destroy = (error) => {
      request.emit('error', error)
      request.emit('close')
    }
    request.end = () =>
      queueMicrotask(() => {
        beforeResponse()
        if (networkFails) {
          request.destroy(new Error('offline'))
          return
        }
        const response = new EventEmitter()
        response.statusCode = 200
        onResponse(response)
        response.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              rate_limit: {
                primary_window: { used_percent: usedPercent, limit_window_seconds: 18000 }
              }
            })
          )
        )
        response.emit('end')
        request.emit('close')
      })
    return request
  })

  const first = await collectUsageSnapshot()
  assert.equal(first.rateLimitSource, 'official')
  auth = authFor('account-a', 2)
  networkFails = true
  const renewed = await collectUsageSnapshot()
  assert.equal(renewed.rateLimitSource, 'cache')
  assert.equal(renewed.rateLimits[0].usedPercent, 42)
  assert.equal(renewed.lastSuccessAt, first.lastSuccessAt)

  networkFails = false
  usedPercent = 88
  beforeResponse = () => {
    auth = authFor('account-a', 3)
  }
  const renewedDuringRequest = await collectUsageSnapshot()
  assert.equal(renewedDuringRequest.rateLimitSource, 'cache')
  assert.equal(renewedDuringRequest.rateLimits[0].usedPercent, 42)

  beforeResponse = () => {}
  const recovered = await collectUsageSnapshot()
  assert.equal(recovered.rateLimitSource, 'official')
  assert.equal(recovered.rateLimits[0].usedPercent, 88)

  beforeResponse = () => {
    auth = authFor('account-b', 1)
  }
  const switched = await collectUsageSnapshot()
  assert.equal(switched.rateLimitSource, 'none')
  assert.deepEqual(switched.rateLimits, [])
  beforeResponse = () => {}
  networkFails = true
  assert.deepEqual((await collectUsageSnapshot()).rateLimits, [])

  networkFails = false
  await collectUsageSnapshot()
  beforeResponse = () => {
    auth = null
  }
  assert.deepEqual((await collectUsageSnapshot()).rateLimits, [])
})

test('历史结果只供同一账号短时回退', () => {
  const snapshot = { lastSuccessAt: observedAt.toISOString(), rateLimits: [] }
  const cached = { key: 'account-a', snapshot }
  assert.equal(selectCachedSnapshot(cached, 'account-a', observedAt.getTime() + 1000), snapshot)
  assert.equal(selectCachedSnapshot(cached, 'account-b', observedAt.getTime()), undefined)
  assert.equal(selectCachedSnapshot(cached, 'account-a', observedAt.getTime() + 900001), undefined)
  assert.equal(selectCachedSnapshot(cached, 'account-a', observedAt.getTime() - 1), undefined)
})

test('账号与用户共同隔离缓存,缺少账号时不发送无归属请求', () => {
  const token = (sub, account, exp = 1) =>
    `header.${Buffer.from(
      JSON.stringify({
        sub,
        exp,
        'https://api.openai.com/auth': { chatgpt_account_id: account }
      })
    ).toString('base64url')}.signature`
  const credentials = (access_token, account_id) =>
    parseCodexCredentials({ tokens: { access_token, account_id } }).credentials
  const first = credentials(token('user-a', 'workspace-a'))
  assert.equal(first.accountId, 'workspace-a')
  assert.equal(first.key, credentials(token('user-a', 'workspace-a', 2)).key)
  assert.notEqual(first.key, credentials(token('user-b', 'workspace-a')).key)
  assert.notEqual(first.key, credentials(token('user-a', 'workspace-b')).key)
  assert.equal(credentials('opaque-token'), undefined)
  assert.equal(credentials(token('user-a', 'workspace-a'), 'workspace-b'), undefined)
  assert.equal(
    parseCodexCredentials({ auth_mode: 'apikey', tokens: { access_token: token('a', 'b') } })
      .credentials,
    undefined
  )
})

test('窗口过期不推算为满额,非法值不覆盖上次结果', () => {
  const parse = (window) =>
    parseOfficialRateLimits({ rate_limit: { primary_window: window } }, observedAt)
  const expired = parse({
    used_percent: 72,
    reset_at: observedAt.getTime() / 1000 - 1,
    limit_window_seconds: 18000
  })
  assert.equal(expired[0].remainingPercent, 28)
  assert.equal(expired[0].resetsInSeconds, 0)
  assert.equal(parse({ used_percent: '20junk' }), undefined)
  assert.equal(parse({ used_percent: 101 }), undefined)
  assert.equal(parse({ reset_at: 123 }), undefined)
  assert.equal(
    parseOfficialRateLimits({ rate_limit: { primary_window: 'invalid' } }, observedAt),
    undefined
  )
  assert.equal(
    parse({ used_percent: 0, reset_after_seconds: 60 })[0].resetsAt,
    '2026-09-07T00:01:00.000Z'
  )
})

test('按官方返回的全部窗口解析计时状态', () => {
  assert.deepEqual(
    parseOfficialDispatchResetAts({
      rate_limit: {
        primary_window: { reset_at: 123 },
        secondary_window: { reset_at: 456 }
      }
    }),
    { primary: 123, secondary: 456 }
  )
  assert.deepEqual(
    parseOfficialDispatchResetAts({ rate_limit: { primary_window: { reset_at: 123 } } }),
    { primary: 123 }
  )
  assert.equal(parseOfficialDispatchResetAts({ rate_limit: {} }), null)
  assert.equal(parseOfficialDispatchResetAts({}), undefined)

  assert.equal(
    areOfficialDispatchResetAtsStable(
      { primary: 123, secondary: 456 },
      { primary: 125, secondary: 458 },
      3
    ),
    true
  )
  assert.equal(
    areOfficialDispatchResetAtsStable(
      { primary: 123, secondary: 456 },
      { primary: 125, secondary: 464 },
      3
    ),
    false
  )

  const rateLimits = parseOfficialRateLimits(
    {
      rate_limit: {
        secondary_window: { used_percent: 20 },
        daily_window: { limit_window_seconds: 86400, used_percent: 30 }
      }
    },
    new Date('2026-07-13T00:00:00Z')
  )
  assert.deepEqual(
    rateLimits?.map(({ id, label, usedPercent }) => ({ id, label, usedPercent })),
    [
      { id: 'daily', label: '1d', usedPercent: 30 },
      { id: 'secondary', label: 'secondary', usedPercent: 20 }
    ]
  )
  assert.deepEqual(parseOfficialRateLimits({ rate_limit: {} }, new Date()), [])
})
