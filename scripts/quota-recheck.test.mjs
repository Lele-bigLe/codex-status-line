import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs, readFileSync } from 'node:fs'
import ts from 'typescript'

// 在 Node 中替换 Electron 网络边界，真实采集逻辑仍从源码编译并运行。
const electronModule = `data:text/javascript;base64,${Buffer.from('export const net = { fetch: async () => { throw new Error("Unexpected network request") } }').toString('base64')}`
const { net } = await import(electronModule)
const compiled = ts
  .transpileModule(
    readFileSync(new URL('../src/main/services/quota.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    }
  )
  .outputText.replace(/from (['"])electron\1/, `from '${electronModule}'`)
const {
  parseOfficialRateLimits,
  parseCodexCredentials,
  selectCachedSnapshot,
  collectUsageSnapshot,
  clearQuotaCache,
  requestJson
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const observedAt = new Date('2026-09-07T00:00:00Z')

test('Chromium请求禁用Cookie和重定向,并区分HTTP/代理/DNS/证书错误', async (t) => {
  let responseStatus = 200
  let networkError
  let responseText = '{"ok":true}'
  t.mock.method(net, 'fetch', async (_url, options) => {
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'manual')
    assert.equal(options.cache, 'no-store')
    assert.ok(options.signal instanceof AbortSignal)
    if (networkError) throw new Error(networkError)
    return new Response(responseText, { status: responseStatus })
  })
  assert.deepEqual(await requestJson('https://example.test', {}, 20000), { ok: true })
  for (const status of [401, 403, 407, 429, 302]) {
    responseStatus = status
    await assert.rejects(
      requestJson('https://example.test', {}, 20000),
      (error) => error.message.includes(`HTTP ${status}`) && !error.retryable
    )
  }
  responseStatus = 200
  responseText = '<html>login</html>'
  await assert.rejects(
    requestJson('https://example.test', {}, 20000),
    (error) => !error.retryable && /JSON/.test(error.message)
  )
  for (const [code, label, retryable] of [
    ['ERR_PROXY_CONNECTION_FAILED', '代理', true],
    ['ERR_NAME_NOT_RESOLVED', 'DNS', true],
    ['ERR_CERT_AUTHORITY_INVALID', '证书', false]
  ]) {
    networkError = `net::${code} private-details`
    await assert.rejects(
      requestJson('https://example.test', {}, 20000),
      (error) =>
        error.message.includes(label) &&
        error.retryable === retryable &&
        !error.message.includes('private-details')
    )
  }
})

test('20秒截止时间覆盖连接及响应体读取,并取消底层请求', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let bodyStage = false
  let signal
  t.mock.method(net, 'fetch', async (_url, options) => {
    signal = options.signal
    if (!bodyStage)
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      )
    return new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(new Error('aborted')), {
            once: true
          })
        }
      })
    )
  })
  for (const stage of [false, true]) {
    bodyStage = stage
    const pending = requestJson('https://example.test', {}, 20000)
    await Promise.resolve()
    t.mock.timers.tick(20000)
    await assert.rejects(pending, /请求超时（20秒）/)
    assert.equal(signal.aborted, true)
  }
})

test('临时故障最多重试一次,鉴权/限流不重试,换号后取消旧凭据重试', async (t) => {
  const auth = { tokens: { account_id: 'test-account', access_token: 'test-token' } }
  let currentAuth = auth
  let calls = 0
  let status = 503
  let switchAccount = false
  let retryAfter = false
  t.mock.method(fs, 'readFile', async () => JSON.stringify(currentAuth))
  t.mock.method(net, 'fetch', async () => {
    calls++
    if (switchAccount)
      currentAuth = { tokens: { account_id: 'another-account', access_token: 'another-token' } }
    return new Response(
      JSON.stringify({
        rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } }
      }),
      {
        status: calls > 1 && status === 503 ? 200 : status,
        headers: retryAfter ? { 'Retry-After': '60' } : {}
      }
    )
  })
  clearQuotaCache()
  t.after(clearQuotaCache)
  assert.equal((await collectUsageSnapshot()).rateLimitSource, 'official')
  assert.equal(calls, 2)
  for (const code of [401, 403, 429]) {
    status = code
    calls = 0
    await collectUsageSnapshot()
    assert.equal(calls, 1)
  }
  status = 503
  calls = 0
  retryAfter = true
  await collectUsageSnapshot()
  assert.equal(calls, 1)
  retryAfter = false
  calls = 0
  switchAccount = true
  assert.equal((await collectUsageSnapshot()).rateLimitSource, 'none')
  assert.equal(calls, 1)
})

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
  t.mock.method(net, 'fetch', async () => {
    beforeResponse()
    if (networkFails) throw new Error('net::ERR_CONNECTION_RESET')
    return new Response(
      JSON.stringify({
        rate_limit: { primary_window: { used_percent: usedPercent, limit_window_seconds: 18000 } }
      })
    )
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

test('按官方返回的全部窗口解析额度', () => {
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
