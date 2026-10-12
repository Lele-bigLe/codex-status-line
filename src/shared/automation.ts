export interface ResetCredit {
  id: string
  title?: string
  status: string
  noExpiry?: boolean
  grantedAt?: string
  expiresAt?: string
}

export interface CycleWindow {
  minutes: number
  usedPercent: number
  resetsAt?: string
}

export interface AutomationAccount {
  key: string
  label: string
  planType?: string
  windows: CycleWindow[]
  ordinaryUsageAllowed?: boolean
  availableCount?: number
  credits: ResetCredit[]
  creditsComplete: boolean
  updatedAt: string
}

export type ScheduleRepeat = 'once' | 'daily' | 'weekly' | 'custom'
export interface CustomRepeat {
  every: number
  unit: 'minutes' | 'hours' | 'days' | 'weeks'
  weekdays?: number[]
}
export type SchedulePhase =
  | 'running'
  | 'started'
  | 'unconfirmed'
  | 'alreadyRunning'
  | 'failed'
  | 'missed'
  | 'paused'

export interface CycleSchedule {
  id: string
  name: string
  accountKey: string
  accountLabel: string
  windowMinutes: number
  startsAt: string
  timeZone: string
  repeat: ScheduleRepeat
  customRepeat?: CustomRepeat
  endsOn?: string
  enabled: boolean
  nextRunAt?: string
  lastRun?: { at: string; phase: SchedulePhase; message?: string }
}

export interface ScheduleInput {
  id?: string
  name: string
  accountKey: string
  windowMinutes: number
  startsAt: string
  repeat: ScheduleRepeat
  customRepeat?: CustomRepeat
  endsOn?: string
}

export interface AutomationSnapshot {
  account?: AutomationAccount
  schedules: CycleSchedule[]
  refreshing: boolean
  redeeming: boolean
  pendingReset: boolean
  issue?: string
  resetResult?: string
}

export function usableCredits(account: AutomationAccount, now = Date.now()): ResetCredit[] {
  return account.credits
    .filter(
      (credit) =>
        credit.status === 'available' && (!credit.expiresAt || Date.parse(credit.expiresAt) > now)
    )
    .sort(
      (a, b) =>
        (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) -
          (b.expiresAt ? Date.parse(b.expiresAt) : Infinity) ||
        (a.grantedAt ?? '').localeCompare(b.grantedAt ?? '') ||
        a.id.localeCompare(b.id)
    )
}

export function cycleLabel(minutes: number, english: boolean): string {
  if (minutes === 300) return english ? '5-hour cycle' : '5 小时周期'
  if (minutes === 10080) return english ? 'Weekly cycle' : '周周期'
  return english ? `${minutes} min cycle` : `${minutes} 分钟周期`
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`
}

export function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00`)
  return Number.isFinite(date.getTime()) && localDateKey(date) === value
}

export function isCustomRepeat(value: unknown): value is CustomRepeat {
  const rule = value as CustomRepeat | null
  return Boolean(
    rule &&
    Number.isInteger(rule.every) &&
    rule.every >= 1 &&
    rule.every <= 10000 &&
    ['minutes', 'hours', 'days', 'weeks'].includes(rule.unit) &&
    (rule.unit !== 'weeks' ||
      (Array.isArray(rule.weekdays) &&
        rule.weekdays.length >= 1 &&
        rule.weekdays.length <= 7 &&
        rule.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
        new Set(rule.weekdays).size === rule.weekdays.length))
  )
}

export function nextScheduleRun(
  schedule: Pick<CycleSchedule, 'startsAt' | 'repeat' | 'customRepeat' | 'endsOn'>,
  after: number
): string | undefined {
  const anchor = new Date(schedule.startsAt)
  const start = anchor.getTime()
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(after) ||
    (schedule.endsOn !== undefined && !isDateOnly(schedule.endsOn))
  )
    return undefined
  const finish = (candidate: Date): string | undefined => {
    if (
      !Number.isFinite(candidate.getTime()) ||
      candidate.getTime() < start ||
      candidate.getTime() <= after ||
      (schedule.endsOn && localDateKey(candidate) > schedule.endsOn)
    )
      return undefined
    return candidate.toISOString()
  }
  if (schedule.repeat === 'once') return finish(anchor)
  const rule: CustomRepeat | undefined =
    schedule.repeat === 'custom'
      ? schedule.customRepeat
      : {
          every: 1,
          unit: schedule.repeat === 'weekly' ? 'weeks' : 'days',
          weekdays: [anchor.getDay()]
        }
  if (!isCustomRepeat(rule)) return undefined
  if (rule.unit === 'minutes' || rule.unit === 'hours') {
    const interval = rule.every * (rule.unit === 'minutes' ? 60000 : 3600000)
    return finish(
      new Date(start + Math.max(0, Math.floor((after - start) / interval) + 1) * interval)
    )
  }
  // 用日历日期确定相位，再从原始时刻创建候选，保持夏令时前后的当地执行时间。
  const dayNumber = (date: Date): number =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000
  const anchorDay = dayNumber(anchor)
  const afterDay = dayNumber(new Date(Math.max(after, start)))
  const onDay = (day: number): Date => {
    const candidate = new Date(start)
    candidate.setDate(anchor.getDate() + day - anchorDay)
    return candidate
  }
  if (rule.unit === 'days') {
    let step = Math.max(0, Math.floor((afterDay - anchorDay) / rule.every))
    let candidate = onDay(anchorDay + step * rule.every)
    while (candidate.getTime() <= after) candidate = onDay(anchorDay + ++step * rule.every)
    return finish(candidate)
  }
  const weekStart = anchorDay - ((anchor.getDay() + 6) % 7)
  const weekIndex = Math.max(0, Math.floor((afterDay - weekStart) / 7))
  let activeWeek = Math.floor(weekIndex / rule.every) * rule.every
  const weekdays = rule.weekdays!.map((day) => (day + 6) % 7).sort((a, b) => a - b)
  for (let cycle = 0; cycle < 2; cycle++, activeWeek += rule.every) {
    for (const weekday of weekdays) {
      const candidate = onDay(weekStart + activeWeek * 7 + weekday)
      if (candidate.getTime() >= start && candidate.getTime() > after) return finish(candidate)
    }
  }
  return undefined
}
