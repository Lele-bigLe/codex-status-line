import type { RateLimitWindowSnapshot } from './capsule'

// 标准、短上下文 API 等价价格（USD / 百万 Token），不是订阅扣费权重。
// 来源：https://developers.openai.com/api/docs/pricing ，核对日期 2026-09-15。
export interface ModelPrice {
  input: number
  cached: number
  write: number
  output: number
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-6-astra': { input: 10, cached: 1, write: 12.5, output: 50 },
  'gpt-5.6-sol': { input: 4, cached: 0.4, write: 5, output: 20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, write: 2.5, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, write: 0.25, output: 1.2 }
}

export interface LocalModelUsage {
  model: string
  input: number
  cached: number
  write: number
  output: number
  requests: number
  cost?: number
}

export interface QuotaObservation {
  at: number
  used: number
  cost: number
  unpriced: number
}

export interface WindowEstimate {
  id: string
  label: string
  samples: number
  consumedPercent: number
  totalCost?: number
  remainingCost?: number
  totalLow?: number
  totalHigh?: number
  percentPerHour?: number
  hoursRemaining?: number
  runsOutBeforeReset?: boolean
  confidence: 'insufficient' | 'low' | 'medium'
  reason?: 'scope' | 'samples' | 'unpriced' | 'stale' | 'reset'
}

export interface UsageEstimation {
  startedAt: string
  scopeConfirmed: boolean
  models: LocalModelUsage[]
  windows: WindowEstimate[]
  logIssue: boolean
}

export function normalizeModelPrices(value: unknown): Record<string, ModelPrice> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 64)
      .filter(
        ([model, price]) =>
          /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(model) &&
          price &&
          ['input', 'cached', 'write', 'output'].every(
            (key) =>
              typeof price[key] === 'number' &&
              Number.isFinite(price[key]) &&
              price[key] >= 0 &&
              price[key] <= 1e6
          ) &&
          price.input > 0
      )
      .map(([model, price]) => [
        model,
        { input: price.input, cached: price.cached, write: price.write, output: price.output }
      ])
  )
}

export function equivalentCost(
  usage: LocalModelUsage,
  overrides: Record<string, ModelPrice> = {}
): number | undefined {
  const price = Object.hasOwn(overrides, usage.model)
    ? overrides[usage.model]
    : Object.hasOwn(MODEL_PRICES, usage.model)
      ? MODEL_PRICES[usage.model]
      : undefined
  if (!price) return undefined
  return (
    ((usage.input - usage.cached - usage.write) * price.input +
      usage.cached * price.cached +
      usage.write * price.write +
      usage.output * price.output) /
    1e6
  )
}

export function estimateWindow(
  window: RateLimitWindowSnapshot,
  observations: QuotaObservation[],
  scopeConfirmed: boolean,
  now: number
): WindowEstimate {
  const result: WindowEstimate = {
    id: window.id,
    label: window.label,
    samples: observations.length,
    consumedPercent: 0,
    confidence: 'insufficient',
    reason: 'samples'
  }
  const first = observations[0]
  const last = observations.at(-1)
  const resetAt = Date.parse(window.resetsAt ?? '')
  if (!Number.isFinite(resetAt) || resetAt <= now) return { ...result, reason: 'reset' }
  if (!first || !last) return result
  if (now - last.at > 120000) return { ...result, reason: 'stale' }
  const consumed = last.used - first.used
  result.consumedPercent = Math.max(0, consumed)
  const remaining = Math.max(0, 100 - last.used)
  // 使用最近一小时的连续观测，空闲时间也计入；不是“持续高强度工作”的保证。
  const recent = observations.filter((point) => point.at >= now - 3600000)
  const trendStart = recent[0]
  if (
    trendStart &&
    recent.length >= 3 &&
    last.at - trendStart.at >= 600000 &&
    last.used - trendStart.used >= 2
  ) {
    result.percentPerHour = ((last.used - trendStart.used) * 3600000) / (last.at - trendStart.at)
    result.hoursRemaining = remaining / result.percentPerHour
    result.runsOutBeforeReset = result.hoursRemaining * 3600000 < resetAt - now
  }
  if (!scopeConfirmed) return { ...result, reason: 'scope' }
  if (last.unpriced > first.unpriced) return { ...result, reason: 'unpriced' }
  if (
    consumed < 5 ||
    observations.length < 3 ||
    last.at - first.at < 600000 ||
    last.cost <= first.cost
  )
    return result
  const cost = last.cost - first.cost
  result.totalCost = (cost * 100) / consumed
  result.remainingCost = (result.totalCost * remaining) / 100
  // 范围仅反映百分比约 1 个百分点的量化误差，不是统计置信区间。
  result.totalLow = (cost * 100) / (consumed + 1)
  result.totalHigh = (cost * 100) / (consumed - 1)
  result.confidence = consumed >= 20 && observations.length >= 10 ? 'medium' : 'low'
  result.reason = undefined
  return result
}
