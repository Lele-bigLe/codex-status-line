import type { AppSettings, LocaleCode, PercentageMode, UsageSnapshot } from '../../shared/capsule'
import { COPY } from './copy'

export function getUsageStatus(
  snapshot: UsageSnapshot,
  settings: AppSettings,
  now: number
): {
  isStale: boolean
  statusLabel: string
} {
  const copy = COPY[settings.locale]
  const isStale =
    snapshot.rateLimitSource === 'cache' ||
    Boolean(
      snapshot.lastSuccessAt &&
      (now - Date.parse(snapshot.lastSuccessAt) >
        Math.max(90000, settings.refreshIntervalSeconds * 2000) ||
        snapshot.rateLimits.some((window) => window.resetsAt && Date.parse(window.resetsAt) <= now))
    )
  const statusLabel = snapshot.isRefreshing
    ? copy.syncing
    : isStale
      ? copy.stale
      : snapshot.rateLimitSource === 'official'
        ? copy.synced
        : copy.disconnected
  return { isStale, statusLabel }
}

export function resolveMetricTone(
  displayPercent: number | undefined,
  percentageMode: PercentageMode
): 'positive' | 'warning' | 'danger' | 'muted' {
  if (displayPercent === undefined) return 'muted'
  const goodScore = percentageMode === 'remaining' ? displayPercent : 100 - displayPercent
  if (goodScore >= 65) return 'positive'
  if (goodScore >= 35) return 'warning'
  return 'danger'
}

export function formatAbsoluteDate(value: string | undefined, locale: LocaleCode): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  const sameDay = isSameDay(date, now)

  if (locale === 'zh-CN') {
    const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(
      date
    )
    if (sameDay) return `${COPY['zh-CN'].today} ${time}`
    return sameYear
      ? `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
      : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`
  }

  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date)
  if (sameDay) return `${COPY['en-US'].today}, ${time}`
  return sameYear
    ? `${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)}, ${time}`
    : `${new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)}, ${time}`
}

export function formatRelativeDuration(
  value: number | undefined,
  locale: LocaleCode,
  withSuffix = false
): string | undefined {
  if (value === undefined) return undefined
  const totalSeconds = Math.max(0, Math.floor(value))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const parts: string[] = []

  if (locale === 'zh-CN') {
    if (days > 0) parts.push(`${days}天`)
    if (hours > 0) parts.push(`${hours}小时`)
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes}分`)
    return `${parts.slice(0, 2).join('')}${withSuffix ? '后' : ''}`
  }

  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`)
  return parts.slice(0, 2).join(' ')
}

export function formatRelativeDate(
  value: string | undefined,
  locale: LocaleCode
): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  const diffSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (diffSeconds < 60) return locale === 'zh-CN' ? '刚刚' : 'just now'
  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) return locale === 'zh-CN' ? `${diffMinutes}分钟前` : `${diffMinutes}m ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return locale === 'zh-CN' ? `${diffHours}小时前` : `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return locale === 'zh-CN' ? `${diffDays}天前` : `${diffDays}d ago`
}

export function formatCapsuleResetTime(value: string | undefined, locale: LocaleCode): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  const now = new Date()
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
  if (isSameDay(date, now)) return time
  const monthDay = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(
    date
  )
  return `${monthDay} ${time}`
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}
