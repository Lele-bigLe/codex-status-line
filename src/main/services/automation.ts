import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexClient } from './codex'
import type {
  AutomationAccount,
  AutomationSnapshot,
  CycleSchedule,
  ScheduleInput,
  SchedulePhase
} from '../../shared/automation'
import {
  usableCredits,
  isDateOnly,
  isCustomRepeat,
  nextScheduleRun as advance
} from '../../shared/automation'

interface ResetAttempt {
  accountKey: string
  creditId: string
  idempotencyKey: string
}
interface StoredAutomation {
  schedules: CycleSchedule[]
  resetAttempts: ResetAttempt[]
}
const HASH = /^[a-f0-9]{64}$/
const ID = /^[a-f0-9-]{36}$/
const validDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
const message = (error: unknown): string =>
  error instanceof Error ? error.message : '操作失败 / Operation failed'
const currentTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

function validateSchedule(value: unknown): CycleSchedule {
  const row = value as CycleSchedule | null
  if (
    !row ||
    typeof row.id !== 'string' ||
    !ID.test(row.id) ||
    typeof row.name !== 'string' ||
    !row.name.trim() ||
    row.name.length > 160 ||
    typeof row.accountKey !== 'string' ||
    !HASH.test(row.accountKey) ||
    typeof row.accountLabel !== 'string' ||
    row.accountLabel.length > 256 ||
    !Number.isFinite(row.windowMinutes) ||
    row.windowMinutes <= 0 ||
    !validDate(row.startsAt) ||
    typeof row.timeZone !== 'string' ||
    row.timeZone.length > 100 ||
    !['once', 'daily', 'weekly', 'custom'].includes(row.repeat) ||
    (row.repeat === 'custom' && !isCustomRepeat(row.customRepeat)) ||
    (row.endsOn !== undefined && !isDateOnly(row.endsOn)) ||
    typeof row.enabled !== 'boolean' ||
    (row.nextRunAt !== undefined && !validDate(row.nextRunAt)) ||
    (row.enabled && !row.nextRunAt) ||
    (row.lastRun &&
      (!validDate(row.lastRun.at) ||
        ![
          'running',
          'started',
          'unconfirmed',
          'alreadyRunning',
          'failed',
          'missed',
          'paused'
        ].includes(row.lastRun.phase) ||
        (row.lastRun.message !== undefined &&
          (typeof row.lastRun.message !== 'string' || row.lastRun.message.length > 1000))))
  ) {
    throw new Error('定时任务数据无效 / Invalid schedule data')
  }
  return row
}

export class AutomationService {
  private state: StoredAutomation = { schedules: [], resetAttempts: [] }
  private account?: AutomationAccount
  private issue?: string
  private resetResult?: string
  private refreshPromise?: Promise<AutomationSnapshot>
  private initialized = false
  private resetPromise?: Promise<AutomationSnapshot>
  private writes: Promise<void> = Promise.resolve()
  private canPersist = true
  private revision = 0
  private accountKey?: string
  private stopped = false
  private suspended = false
  private ticking?: Promise<void>
  private timer?: NodeJS.Timeout
  private client = new CodexClient()

  constructor(
    private file: string,
    private triggerDirectory: string,
    private onChanged: (snapshot: AutomationSnapshot) => void,
    private onUsageChanged: () => void
  ) {}

  snapshot(): AutomationSnapshot {
    const pending = this.state.resetAttempts.find(
      (attempt) => attempt.accountKey === this.account?.key
    )
    return {
      account: this.account,
      schedules: this.state.schedules,
      refreshing: Boolean(this.refreshPromise),
      redeeming: Boolean(this.resetPromise),
      pendingReset: Boolean(pending),
      pendingResetCreditId: pending?.creditId,
      issue: this.issue,
      resetResult: this.resetResult
    }
  }

  private publish(): void {
    this.onChanged(this.snapshot())
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as StoredAutomation
      if (!Array.isArray(parsed?.schedules) || !Array.isArray(parsed?.resetAttempts))
        throw new Error('Invalid state')
      const schedules = parsed.schedules.map(validateSchedule)
      const resetAttempts = parsed.resetAttempts
      if (
        new Set(schedules.map((schedule) => schedule.id)).size !== schedules.length ||
        new Set(resetAttempts.map((attempt) => attempt.accountKey)).size !== resetAttempts.length ||
        resetAttempts.some(
          (attempt) =>
            !attempt ||
            typeof attempt.accountKey !== 'string' ||
            !HASH.test(attempt.accountKey) ||
            typeof attempt.creditId !== 'string' ||
            !attempt.creditId ||
            attempt.creditId.length > 512 ||
            typeof attempt.idempotencyKey !== 'string' ||
            !ID.test(attempt.idempotencyKey)
        )
      )
        throw new Error('Invalid state')
      this.state = { schedules, resetAttempts }
      for (const schedule of schedules)
        if (schedule.lastRun?.phase === 'running') {
          schedule.lastRun = {
            ...schedule.lastRun,
            phase: 'unconfirmed',
            message: '上次执行中断，未自动重发 / Previous run interrupted; not retried'
          }
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.canPersist = false
        this.issue =
          '定时任务文件读取失败，已停止执行并保留原文件 / Could not read schedules; execution stopped and the file was preserved'
      }
    }
  }

  async start(): Promise<void> {
    if (!this.canPersist) return
    try {
      await this.skipOverdue()
    } catch {
      return
    }
    this.timer = setInterval(() => {
      if (!this.stopped && !this.suspended && !this.ticking) {
        this.ticking = this.tick()
          .catch((error) => {
            this.issue = message(error)
            this.publish()
          })
          .finally(() => {
            this.ticking = undefined
          })
      }
    }, 1000)
  }

  suspend(): void {
    this.suspended = true
    this.client.cancel()
  }
  async resume(): Promise<void> {
    try {
      await this.skipOverdue()
    } catch (error) {
      this.issue = message(error)
      this.publish()
    }
    this.suspended = false
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.invalidate()
    await this.ticking
    await this.resetPromise?.catch(() => {})
    await this.refreshPromise?.catch(() => {})
    await this.writes
  }

  invalidate(): void {
    this.revision++
    this.client.cancel()
    this.account = undefined
    this.initialized = false
    this.resetResult = undefined
    this.publish()
  }

  async accountChanged(key: string | undefined): Promise<void> {
    this.accountKey = key
    this.invalidate()
    if (
      !this.canPersist ||
      !this.state.schedules.some((schedule) => schedule.enabled && schedule.accountKey !== key)
    )
      return
    await this.mutate((state) => {
      for (const schedule of state.schedules)
        if (schedule.enabled && schedule.accountKey !== key) {
          schedule.enabled = false
          if (schedule.lastRun?.phase !== 'running')
            schedule.lastRun = {
              at: new Date().toISOString(),
              phase: 'paused',
              message:
                '监测账号已变化，请切回原账号后重新启用 / Account changed; switch back before enabling'
            }
        }
    })
  }

  refresh(force = true): Promise<AutomationSnapshot> {
    if (this.stopped) return Promise.resolve(this.snapshot())
    if (this.resetPromise) return this.resetPromise
    if (this.refreshPromise) return this.refreshPromise
    if (!force && this.initialized) return Promise.resolve(this.snapshot())
    this.initialized = true
    const revision = this.revision
    const run = this.client
      .withAccount(undefined, async (_, account) => {
        if (revision === this.revision) {
          this.account = account
          if (this.canPersist) this.issue = undefined
          if (
            this.canPersist &&
            this.state.schedules.some(
              (schedule) =>
                schedule.enabled &&
                (schedule.accountKey !== account.key ||
                  !account.windows.some((window) => window.minutes === schedule.windowMinutes))
            )
          ) {
            await this.mutate((state) => {
              for (const schedule of state.schedules)
                if (
                  schedule.enabled &&
                  schedule.lastRun?.phase !== 'running' &&
                  (schedule.accountKey !== account.key ||
                    !account.windows.some((window) => window.minutes === schedule.windowMinutes))
                ) {
                  schedule.enabled = false
                  schedule.lastRun = {
                    at: new Date().toISOString(),
                    phase: 'paused',
                    message:
                      '账号或订阅周期已变化，请重新配置 / Account or subscription window changed; reconfigure this schedule'
                  }
                }
            })
          }
        }
      })
      .catch((error) => {
        if (revision === this.revision) {
          this.account = undefined
          this.issue = message(error)
        }
      })
      .then(() => this.snapshot())
      .finally(() => {
        this.refreshPromise = undefined
        this.publish()
      })
    this.refreshPromise = run
    this.publish()
    return run
  }

  consumeReset(key: unknown, creditId: unknown): Promise<AutomationSnapshot> {
    if (typeof key !== 'string' || !HASH.test(key))
      return Promise.reject(new Error('请刷新账号信息 / Refresh account information first'))
    if (typeof creditId !== 'string' || !creditId || creditId.length > 512)
      return Promise.reject(new Error('请选择有效的重置卡 / Select a valid reset credit'))
    if (this.resetPromise)
      return Promise.reject(
        new Error('正在处理重置，请等待本次结果 / A reset is in progress; wait for its result')
      )
    const revision = this.revision
    this.resetResult = undefined
    const run = (async () => {
      await this.refreshPromise
      await this.client.withAccount(key, async (session, account, check) => {
        if (this.stopped) throw new Error('应用正在退出 / App is quitting')
        this.account = account
        let attempt = this.state.resetAttempts.find((item) => item.accountKey === key)
        if (attempt && attempt.creditId !== creditId)
          throw new Error(
            '请先确认上次重置结果，再使用其他卡 / Confirm the pending reset before using another credit'
          )
        if (!attempt) {
          if (!account.creditsComplete)
            throw new Error(
              '卡片明细不完整，请刷新后重试 / Credit details are incomplete; refresh and try again'
            )
          const credit = usableCredits(account).find((item) => item.id === creditId)
          if (!credit)
            throw new Error(
              '所选重置卡已不可用，请刷新 / The selected reset credit is unavailable; refresh first'
            )
          attempt = { accountKey: key, creditId: credit.id, idempotencyKey: randomUUID() }
          const pending = attempt
          // 先落盘兑换标识，再发送请求；超时或重启后仍复用同一次兑换。
          await this.mutate((state) => {
            state.resetAttempts.push(pending)
          })
        }
        await check()
        if (revision !== this.revision || this.stopped || this.suspended)
          throw new Error('重置已取消 / Reset cancelled')
        const response = (await session.request('account/rateLimitResetCredit/consume', {
          creditId: attempt.creditId,
          idempotencyKey: attempt.idempotencyKey
        })) as { outcome?: string } | undefined
        const outcome = response?.outcome
        const results: Record<string, string> = {
          reset: '重置成功 / Reset successful',
          alreadyRedeemed: '本次重置已完成 / This reset was already completed',
          nothingToReset: '当前没有可重置的额度窗口 / No eligible window to reset',
          noCredit: '没有可用的重置卡 / No reset credits available'
        }
        if (!outcome || !results[outcome])
          throw new Error(
            '重置结果尚未确认，请重试确认 / Reset outcome is unknown; retry to confirm'
          )
        await this.mutate((state) => {
          state.resetAttempts = state.resetAttempts.filter((item) => item.accountKey !== key)
        })
        if (revision === this.revision) this.resetResult = results[outcome]
        this.onUsageChanged()
        try {
          const updated = await this.client.read(
            session,
            account.key,
            account.label,
            account.planType
          )
          await check()
          if (revision === this.revision) {
            this.account = updated
            if (this.canPersist) this.issue = undefined
          }
        } catch {
          if (revision === this.revision) {
            this.account = undefined
            this.issue =
              '兑换结果已返回，额度同步失败，请刷新 / Redemption returned; limit refresh failed'
          }
        }
      })
    })()
      .catch((error) => {
        if (revision === this.revision) this.resetResult = message(error)
      })
      .then(() => this.snapshot())
      .finally(() => {
        this.resetPromise = undefined
        this.publish()
      })
    this.resetPromise = run
    this.publish()
    return run
  }

  async saveSchedule(value: unknown): Promise<AutomationSnapshot> {
    const input = value as ScheduleInput | null
    if (
      !input ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 160 ||
      typeof input.accountKey !== 'string' ||
      !HASH.test(input.accountKey) ||
      !validDate(input.startsAt) ||
      Date.parse(input.startsAt) <= Date.now() ||
      !['once', 'daily', 'weekly', 'custom'].includes(input.repeat) ||
      (input.repeat === 'custom' && !isCustomRepeat(input.customRepeat)) ||
      (input.endsOn !== undefined && !isDateOnly(input.endsOn)) ||
      (input.id !== undefined && (typeof input.id !== 'string' || !ID.test(input.id)))
    ) {
      throw new Error('请填写名称和未来执行时间 / Enter a name and a future execution time')
    }
    await this.client.withAccount(input.accountKey, async (_, account, check) => {
      if (!account.windows.some((window) => window.minutes === input.windowMinutes)) {
        throw new Error(
          '当前订阅没有所选周期，请刷新 / The selected window is not available; refresh first'
        )
      }
      await check()
      await this.mutate((state) => {
        if (this.stopped || this.accountKey !== input.accountKey)
          throw new Error('账号已变化，任务未保存 / Account changed; schedule was not saved')
        if (Date.parse(input.startsAt) <= Date.now())
          throw new Error(
            '执行时间已过，请选择未来时间 / Execution time passed; select a future time'
          )
        const existing = input.id
          ? state.schedules.find((schedule) => schedule.id === input.id)
          : undefined
        if (input.id && (!existing || existing.accountKey !== input.accountKey))
          throw new Error('任务或账号已变化 / Schedule or account changed')
        if (existing?.lastRun?.phase === 'running')
          throw new Error('任务正在执行，请稍后编辑 / Wait for the current run before editing')
        const schedule: CycleSchedule = {
          id: existing?.id ?? randomUUID(),
          name: input.name.trim(),
          accountKey: account.key,
          accountLabel: account.label,
          windowMinutes: input.windowMinutes,
          startsAt: input.startsAt,
          timeZone: currentTimeZone(),
          repeat: input.repeat,
          customRepeat: input.repeat === 'custom' ? input.customRepeat : undefined,
          endsOn: input.repeat === 'once' ? undefined : input.endsOn,
          enabled: true,
          nextRunAt: input.startsAt,
          lastRun: existing?.lastRun
        }
        schedule.nextRunAt = advance(schedule, Date.now())
        if (!schedule.nextRunAt)
          throw new Error(
            '结束日期内没有有效的执行时间，请调整重复规则 / No run fits before the end date; adjust the recurrence'
          )
        if (existing) state.schedules[state.schedules.indexOf(existing)] = schedule
        else state.schedules.push(schedule)
      })
    })
    return this.snapshot()
  }

  async setEnabled(id: unknown, enabled: unknown): Promise<AutomationSnapshot> {
    if (typeof id !== 'string' || typeof enabled !== 'boolean')
      throw new Error('任务参数无效 / Invalid schedule parameters')
    const schedule = this.state.schedules.find((item) => item.id === id)
    if (!schedule) throw new Error('任务不存在 / Schedule not found')
    if (enabled)
      await this.client.withAccount(schedule.accountKey, async (_, account, check) => {
        if (!account.windows.some((window) => window.minutes === schedule.windowMinutes))
          throw new Error('当前订阅没有此周期 / The subscription no longer has this window')
        await check()
      })
    await this.mutate((state) => {
      const row = state.schedules.find((item) => item.id === id)
      if (!row || row.lastRun?.phase === 'running')
        throw new Error('任务正在执行或已移除 / Schedule is running or was removed')
      if (enabled && (this.stopped || row.accountKey !== this.accountKey))
        throw new Error('账号已变化，任务未启用 / Account changed; schedule was not enabled')
      if (enabled && row.timeZone !== currentTimeZone())
        throw new Error(
          '系统时区已变化，请重新保存任务 / Time zone changed; save the schedule again'
        )
      if (enabled && (!row.nextRunAt || Date.parse(row.nextRunAt) <= Date.now())) {
        row.nextRunAt = advance(row, Date.now())
        if (!row.nextRunAt)
          throw new Error(
            '任务没有未来执行时间，请编辑开始时间或结束日期 / No future runs remain; edit the start time or end date'
          )
      }
      row.enabled = enabled
    })
    return this.snapshot()
  }

  async remove(id: unknown): Promise<AutomationSnapshot> {
    if (typeof id !== 'string') throw new Error('任务参数无效 / Invalid schedule parameters')
    await this.mutate((state) => {
      if (state.schedules.find((schedule) => schedule.id === id)?.lastRun?.phase === 'running') {
        throw new Error('任务正在执行，请稍后删除 / Wait for the current run before deleting')
      }
      state.schedules = state.schedules.filter((schedule) => schedule.id !== id)
    })
    return this.snapshot()
  }

  private async mutate(change: (state: StoredAutomation) => void): Promise<void> {
    const write = this.writes.then(async () => {
      if (!this.canPersist)
        throw new Error(
          '任务文件不可写，已保留原文件 / Schedule file is unavailable; original file preserved'
        )
      const next = structuredClone(this.state)
      change(next)
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      try {
        await fs.writeFile(`${this.file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600
        })
        await fs.rename(`${this.file}.tmp`, this.file)
      } catch {
        this.canPersist = false
        this.issue =
          '定时任务未保存，执行已停止，请检查文件权限后重启 / Could not save schedules; execution stopped. Check file permissions and restart'
        this.publish()
        throw new Error(this.issue)
      }
      this.state = next
      this.publish()
    })
    this.writes = write.catch(() => {})
    await write
  }

  private async skipOverdue(): Promise<void> {
    if (
      !this.canPersist ||
      !this.state.schedules.some(
        (schedule) =>
          schedule.enabled && schedule.nextRunAt && Date.parse(schedule.nextRunAt) <= Date.now()
      )
    )
      return
    await this.mutate((state) => {
      const now = Date.now()
      for (const schedule of state.schedules)
        if (schedule.enabled && schedule.nextRunAt && Date.parse(schedule.nextRunAt) <= now) {
          schedule.lastRun = {
            at: new Date(now).toISOString(),
            phase: 'missed',
            message:
              '应用关闭或电脑休眠时错过，未补发 / Missed while the app was closed or computer asleep; not replayed'
          }
          schedule.nextRunAt = advance(schedule, now)
          schedule.enabled = Boolean(schedule.nextRunAt)
        }
    })
  }

  private async tick(): Promise<void> {
    if (!this.canPersist || this.resetPromise) return
    const due = this.state.schedules.filter(
      (schedule) =>
        schedule.enabled && schedule.nextRunAt && Date.parse(schedule.nextRunAt) <= Date.now()
    )
    for (const candidate of due) {
      if (this.stopped || this.suspended || this.resetPromise) return
      let reserved: CycleSchedule | undefined
      await this.mutate((state) => {
        const schedule = state.schedules.find((item) => item.id === candidate.id)
        if (
          !schedule?.enabled ||
          !schedule.nextRunAt ||
          Date.parse(schedule.nextRunAt) > Date.now()
        )
          return
        const now = Date.now()
        const phase: SchedulePhase =
          schedule.timeZone !== currentTimeZone()
            ? 'paused'
            : now - Date.parse(schedule.nextRunAt) > 30000
              ? 'missed'
              : 'running'
        schedule.lastRun = {
          at: new Date(now).toISOString(),
          phase,
          message:
            phase === 'paused'
              ? '系统时区已变化，请重新保存 / Time zone changed; save again'
              : phase === 'missed'
                ? '错过执行时间，未补发 / Execution time missed; not replayed'
                : undefined
        }
        schedule.nextRunAt = advance(schedule, now)
        schedule.enabled = phase !== 'paused' && Boolean(schedule.nextRunAt)
        if (phase === 'running') reserved = structuredClone(schedule)
      })
      if (reserved) await this.execute(reserved)
    }
  }

  private async execute(schedule: CycleSchedule): Promise<void> {
    let phase: SchedulePhase = 'failed'
    let result: string | undefined
    let attempted = false
    try {
      await this.client.withAccount(schedule.accountKey, async (session, account, check) => {
        if (this.stopped || this.suspended)
          throw new Error(
            '应用退出或电脑休眠，未触发 / App stopped or computer suspended; not triggered'
          )
        const window = account.windows.find((item) => item.minutes === schedule.windowMinutes)
        if (!window) {
          phase = 'paused'
          result = '订阅周期已变化，请重新配置 / Subscription window changed; reconfigure'
          return
        }
        this.account = account
        if (window.resetsAt && Date.parse(window.resetsAt) > Date.now()) {
          phase = 'alreadyRunning'
          result = '目标周期已在计时，已跳过 / Target window is already running; skipped'
          return
        }
        if (account.ordinaryUsageAllowed !== true) {
          throw new Error(
            account.ordinaryUsageAllowed === false
              ? '官方未允许使用订阅额度，未触发 / Included usage is not permitted; not triggered'
              : '官方未确认订阅额度可用，未触发 / Included usage availability is unknown; not triggered'
          )
        }
        await fs.mkdir(this.triggerDirectory, { recursive: true })
        await check()
        if (this.stopped || this.suspended) throw new Error('触发已取消 / Trigger cancelled')
        attempted = true
        await session.trigger(this.triggerDirectory, check)
        this.onUsageChanged()
        const after = await this.client.read(session, account.key, account.label, account.planType)
        await check()
        this.account = after
        const updated = after.windows.find((item) => item.minutes === schedule.windowMinutes)
        phase =
          updated?.resetsAt && Date.parse(updated.resetsAt) > Date.now() ? 'started' : 'unconfirmed'
        result =
          phase === 'started'
            ? '官方已确认周期开始 / Cycle start confirmed by the service'
            : '请求已完成，官方尚未确认新周期 / Request completed; a new cycle has not been confirmed'
      })
    } catch (error) {
      phase = attempted ? 'unconfirmed' : 'failed'
      result = message(error)
    }
    await this.mutate((state) => {
      const row = state.schedules.find((item) => item.id === schedule.id)
      if (!row || row.lastRun?.at !== schedule.lastRun?.at) return
      row.lastRun = { at: schedule.lastRun!.at, phase, message: result }
      if (phase === 'paused') row.enabled = false
    })
    this.publish()
  }
}
