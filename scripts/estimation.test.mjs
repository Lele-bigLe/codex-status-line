import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadTs } from './load-ts.mjs'

const { estimateWindow, equivalentCost, normalizeModelPrices } = await import(
  loadTs(new URL('../src/shared/estimation.ts', import.meta.url))
)
const { readUsageRecord, LocalUsageReader } = await import(
  loadTs(new URL('../src/main/services/local-usage.ts', import.meta.url))
)
const { UsageEstimator } = await import(
  loadTs(new URL('../src/main/services/estimation.ts', import.meta.url))
)

test('cost avoids double counting cached and reasoning tokens; unknown models stay unpriced', () => {
  const usage = {
    model: 'gpt-6-astra',
    input: 1000000,
    cached: 200000,
    write: 100000,
    output: 100000
  }
  assert.equal(equivalentCost(usage), 13.45)
  assert.equal(equivalentCost({ ...usage, model: 'unknown' }), undefined)
  assert.equal(
    equivalentCost(
      { ...usage, model: 'custom' },
      { custom: { input: 1, cached: 0, write: 1, output: 1 } }
    ),
    0.9
  )
  assert.deepEqual(normalizeModelPrices({ bad: { input: -1 }, toString: { input: Infinity } }), {})
})

test('total and remaining estimates use only matched samples, with guarded confidence and trend', () => {
  const now = Date.now()
  const window = { id: 'weekly', label: '7d', resetsAt: new Date(now + 2 * 3600000).toISOString() }
  const samples = [
    { at: now - 1800000, used: 20, cost: 100, unpriced: 0 },
    { at: now - 900000, used: 25, cost: 105, unpriced: 0 },
    { at: now, used: 30, cost: 110, unpriced: 0 }
  ]
  const result = estimateWindow(window, samples, true, now)
  assert.equal(result.totalCost, 100)
  assert.equal(result.remainingCost, 70)
  assert.equal(result.percentPerHour, 20)
  assert.equal(result.hoursRemaining, 3.5)
  assert.equal(result.runsOutBeforeReset, false)
  assert.ok(result.totalLow < result.totalCost && result.totalHigh > result.totalCost)
  assert.equal(estimateWindow(window, samples, false, now).totalCost, undefined)
  assert.equal(estimateWindow(window, samples, false, now).percentPerHour, 20)
  assert.equal(estimateWindow(window, samples, true, now + 180000).reason, 'stale')
  assert.equal(
    estimateWindow({ ...window, resetsAt: new Date(now).toISOString() }, samples, true, now).reason,
    'reset'
  )
  assert.equal(estimateWindow(window, samples.slice(0, 1), true, now).totalCost, undefined)
  assert.equal(
    estimateWindow(
      window,
      samples.map((sample) => ({ ...sample, used: 20 })),
      true,
      now
    ).totalCost,
    undefined
  )
  assert.equal(
    estimateWindow(window, [...samples.slice(0, 2), { ...samples[2], unpriced: 1 }], true, now)
      .reason,
    'unpriced'
  )
})

function tokenEvent(input = 1000, total = input, timestamp = new Date().toISOString()) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 20 },
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 10
        }
      }
    }
  }
}

test('token records use explicit model metadata and deduplicate repeated cumulative events', () => {
  const cursor = { offset: 0, model: 'unknown' }
  readUsageRecord({ type: 'turn_context', payload: { model: 'gpt-6-astra' } }, cursor)
  const result = readUsageRecord(tokenEvent(), cursor)
  assert.equal(result.model, 'gpt-6-astra')
  assert.equal(result.output, 20)
  assert.equal(readUsageRecord(tokenEvent(), cursor), undefined)
  assert.equal(
    readUsageRecord({ type: 'response_item', payload: { type: 'token_count' } }, cursor),
    undefined
  )
  assert.throws(() => readUsageRecord(tokenEvent(-1, 2000), cursor))
})

test('reader ignores historical files, handles partial appends and does not recount a refresh', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-estimate-'))
  try {
    const file = path.join(root, 'session.jsonl')
    await writeFile(file, JSON.stringify(tokenEvent()) + '\n')
    const reader = new LocalUsageReader()
    assert.deepEqual((await reader.scan(root, {})).models, [])
    const event = JSON.stringify(tokenEvent(2000, 3000))
    await appendFile(
      file,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra' } }) +
        '\n' +
        event.slice(0, 40)
    )
    assert.deepEqual((await reader.scan(root, {})).models, [])
    await appendFile(file, event.slice(40) + '\n')
    const local = await reader.scan(root, {})
    assert.equal(local.models[0].input, 2000)
    assert.deepEqual((await reader.scan(root, {})).models, local.models)
    await appendFile(file, JSON.stringify(tokenEvent(2000, 3000)) + '\n')
    assert.deepEqual((await reader.scan(root, {})).models, local.models)
    await writeFile(
      path.join(root, 'copied.jsonl'),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra' } }) +
        '\n' +
        event +
        '\n'
    )
    assert.deepEqual((await reader.scan(root, {})).models, local.models)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('quota tracking isolates windows and invalidates samples on reset, stale data and plan changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-estimate-'))
  try {
    await mkdir(path.join(root, 'sessions'))
    const estimator = new UsageEstimator(true)
    const now = Date.now()
    const make = (at, used, plan = 'pro') => ({
      generatedAt: new Date(at).toISOString(),
      authPath: path.join(root, 'auth.json'),
      rateLimitSource: 'official',
      plan,
      rateLimits: [
        {
          id: 'short',
          label: '5h',
          usedPercent: used,
          resetsAt: new Date(now + 3600000).toISOString()
        },
        {
          id: 'long',
          label: '7d',
          usedPercent: 5,
          resetsAt: new Date(now + 86400000).toISOString()
        }
      ]
    })
    await estimator.update(make(now - 1000, 10), { estimationPrices: {} })
    const second = await estimator.update(make(now, 12), { estimationPrices: {} })
    assert.equal(second.windows[0].consumedPercent, 2)
    assert.equal(second.windows[1].consumedPercent, 0)
    const reset = await estimator.update(make(now + 1, 0), { estimationPrices: {} })
    assert.equal(reset.windows[0].samples, 1)
    const changed = await estimator.update(make(now + 2, 1, 'plus'), { estimationPrices: {} })
    assert.equal(changed.scopeConfirmed, false)
    assert.equal(changed.windows[0].samples, 1)
    const stale = await estimator.update(
      { ...make(now + 3, 2, 'plus'), rateLimitSource: 'cache' },
      { estimationPrices: {} }
    )
    assert.equal(stale.windows[0].reason, 'stale')
    assert.equal(stale.windows[0].totalCost, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
