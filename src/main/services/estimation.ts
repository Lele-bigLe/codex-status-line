import path from 'node:path'
import type { AppSettings, UsageSnapshot } from '../../shared/capsule'
import {
  estimateWindow,
  type QuotaObservation,
  type UsageEstimation
} from '../../shared/estimation'
import { LocalUsageReader } from './local-usage'

export class UsageEstimator {
  private reader = new LocalUsageReader()
  private histories = new Map<
    string,
    { reset: number; minutes?: number; points: QuotaObservation[] }
  >()
  private plan: string | undefined
  private startedAt = new Date().toISOString()

  constructor(private scopeConfirmed = false) {}

  async update(snapshot: UsageSnapshot, settings: AppSettings): Promise<UsageEstimation> {
    const now = Date.parse(snapshot.generatedAt ?? '')
    const local = await this.reader.scan(
      path.join(path.dirname(snapshot.authPath ?? ''), 'sessions'),
      settings.estimationPrices
    )
    if (this.plan !== snapshot.plan) {
      if (this.plan !== undefined) this.scopeConfirmed = false
      this.histories.clear()
      this.plan = snapshot.plan
    }
    const fresh = snapshot.rateLimitSource === 'official' && Number.isFinite(now)
    if (!fresh || local.issue) this.histories.clear()
    const ids = new Set(snapshot.rateLimits.map((window) => window.id))
    for (const id of this.histories.keys()) if (!ids.has(id)) this.histories.delete(id)
    const windows = snapshot.rateLimits.map((window) => {
      const reset = Date.parse(window.resetsAt ?? '')
      const used = window.usedPercent
      let history = this.histories.get(window.id)
      const previous = history?.points.at(-1)
      if (
        !history ||
        !Number.isFinite(history.reset) ||
        !Number.isFinite(reset) ||
        history.minutes !== window.windowMinutes ||
        Math.abs(history.reset - reset) > 3000 ||
        (previous &&
          (now - previous.at > 15 * 60000 ||
            now < previous.at ||
            (used !== undefined && used < previous.used)))
      ) {
        history = { reset, minutes: window.windowMinutes, points: [] }
        this.histories.set(window.id, history)
      }
      if (
        fresh &&
        !local.issue &&
        Number.isFinite(reset) &&
        reset > now &&
        used !== undefined &&
        Number.isFinite(used) &&
        used >= 0 &&
        used <= 100 &&
        previous?.at !== now
      ) {
        history.points.push({ at: now, used, cost: local.cost, unpriced: local.unpriced })
        // 保留基准点和最近观测；总额度按完整采样区间计算，趋势只取最近一小时。
        if (history.points.length > 800) history.points.splice(1, 1)
      }
      const estimate = estimateWindow(window, history.points, this.scopeConfirmed, Date.now())
      return fresh ? estimate : { ...estimate, reason: 'stale' as const }
    })
    return {
      startedAt: this.startedAt,
      scopeConfirmed: this.scopeConfirmed,
      models: local.models,
      windows,
      logIssue: local.issue
    }
  }
}
