import { useEffect, useRef, useState } from 'react'
import {
  cycleLabel,
  localDateKey,
  nextScheduleRun,
  usableCredits,
  type AutomationSnapshot,
  type CustomRepeat,
  type CycleSchedule,
  type ScheduleRepeat
} from '../../../shared/automation'
import type { LocaleCode } from '../../../shared/capsule'

function localDateInput(value: string): string {
  const date = new Date(value)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

function defaultEndDate(): string {
  const date = new Date()
  date.setMonth(date.getMonth() + 1)
  return localDateKey(date)
}

function openDatePicker(event: React.MouseEvent<HTMLInputElement>): void {
  try {
    event.currentTarget.showPicker()
    event.preventDefault()
  } catch {
    /* 保留原生编辑和图标选择。 */
  }
}

export function AutomationPanel({
  view,
  locale,
  now
}: {
  view: 'credits' | 'schedules'
  locale: LocaleCode
  now: number
}): React.JSX.Element {
  const english = locale === 'en-US'
  const text = (zh: string, en: string): string => (english ? en : zh)
  const localizedMessage = (value: string): string => {
    const clean = value.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    const parts = clean.split(' / ')
    return english ? (parts[1] ?? parts[0]) : parts[0]
  }
  const absolute = (value: string | undefined): string =>
    value
      ? new Intl.DateTimeFormat(locale, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short'
        }).format(new Date(value))
      : text('未提供', 'Not provided')
  const [snapshot, setSnapshot] = useState<AutomationSnapshot>({
    schedules: [],
    refreshing: false,
    redeeming: false,
    pendingReset: false
  })
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState('')
  const [editing, setEditing] = useState<string>()
  const [name, setName] = useState('')
  const [startsAt, setStartsAt] = useState(() =>
    localDateInput(new Date(Date.now() + 5 * 60000).toISOString())
  )
  const [minutes, setMinutes] = useState('')
  const [repeat, setRepeat] = useState<ScheduleRepeat>('once')
  const [customEvery, setCustomEvery] = useState('1')
  const [customUnit, setCustomUnit] = useState<CustomRepeat['unit']>('weeks')
  const [weekdays, setWeekdays] = useState<number[]>([new Date(Date.now() + 5 * 60000).getDay()])
  const [endMode, setEndMode] = useState<'never' | 'date'>('never')
  const [endsOn, setEndsOn] = useState(defaultEndDate)
  const active = useRef(false)
  const current = useRef(snapshot)
  const accountKey = useRef<string | undefined>(undefined)
  current.current = snapshot

  useEffect(() => {
    active.current = true
    let received = false
    const accept = (value: AutomationSnapshot): void => {
      if (active.current) {
        received = true
        current.current = value
        setSnapshot(value)
      }
    }
    const dispose = window.codexStatus.onAutomationUpdated(accept)
    void window.codexStatus
      .getAutomation()
      .then((value) => {
        if (!received) accept(value)
      })
      .catch(() => {})
    const refresh = (): void => {
      if (document.hidden || current.current.refreshing || current.current.redeeming) return
      void window.codexStatus
        .refreshAutomation()
        .then(accept)
        .catch(() => {
          if (active.current) setIssue('账号信息读取失败 / Could not load account information')
        })
    }
    refresh()
    const timer = window.setInterval(refresh, 60000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active.current = false
      dispose()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  useEffect(() => {
    const account = snapshot.account
    if (!account) return
    if (accountKey.current !== account.key) {
      accountKey.current = account.key
      setEditing(undefined)
      setName('')
      setRepeat('once')
      setCustomEvery('1')
      setCustomUnit('weeks')
      setWeekdays([new Date(Date.now() + 5 * 60000).getDay()])
      setEndMode('never')
      setEndsOn(defaultEndDate())
      setStartsAt(localDateInput(new Date(Date.now() + 5 * 60000).toISOString()))
      setMinutes(String(account.windows[0]?.minutes ?? ''))
    } else if (!editing && !account.windows.some((window) => String(window.minutes) === minutes)) {
      setMinutes(String(account.windows[0]?.minutes ?? ''))
    }
  }, [snapshot.account, editing, minutes])

  async function act(action: () => Promise<AutomationSnapshot>): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    setIssue('')
    try {
      const value = await action()
      if (active.current) setSnapshot(value)
      return true
    } catch (error) {
      if (active.current)
        setIssue(error instanceof Error ? error.message : '操作失败 / Operation failed')
      return false
    } finally {
      if (active.current) setBusy(false)
    }
  }

  const account = snapshot.account
  const credits = account ? usableCredits(account, now) : []
  const disabled = busy || snapshot.redeeming || snapshot.refreshing
  const refreshButton = (
    <button
      className="ghost-button"
      type="button"
      disabled={disabled}
      onClick={() => {
        void act(() => window.codexStatus.refreshAutomation())
      }}
    >
      {snapshot.refreshing ? text('同步中…', 'Syncing…') : text('刷新', 'Refresh')}
    </button>
  )
  const feedback = (
    <>
      {issue || snapshot.issue ? (
        <p className="automation-message automation-message--warning" role="alert">
          {localizedMessage(issue || snapshot.issue!)}
        </p>
      ) : null}
    </>
  )

  if (view === 'credits')
    return (
      <section className="automation-section" aria-label={text('重置卡', 'Reset credits')}>
        <div className="automation-heading">
          <h3>
            {text('重置卡', 'Reset credits')}
            <span>
              {text('可用', 'Available')} {account?.availableCount ?? '—'}
            </span>
          </h3>
          {refreshButton}
        </div>
        {feedback}
        {account ? (
          <>
            <p className="automation-caption">
              {text(
                '优先使用最早到期的可用卡。',
                'The available credit expiring soonest is used first.'
              )}
            </p>
            {!account.creditsComplete ? (
              <p className="automation-message automation-message--warning">
                {text(
                  '官方未提供完整卡片明细，暂时无法确定最早到期卡。',
                  'Complete credit details are unavailable; earliest expiry cannot be determined.'
                )}
              </p>
            ) : null}
            <div className="reset-credit-list">
              {[...account.credits]
                .sort(
                  (a, b) =>
                    (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) -
                    (b.expiresAt ? Date.parse(b.expiresAt) : Infinity)
                )
                .map((credit) => {
                  const expired = Boolean(credit.expiresAt && Date.parse(credit.expiresAt) <= now)
                  const status = expired ? 'expired' : credit.status
                  const days = credit.expiresAt
                    ? Math.ceil((Date.parse(credit.expiresAt) - now) / 86400000)
                    : undefined
                  return (
                    <article
                      className={`reset-credit${status === 'available' ? '' : ' reset-credit--inactive'}`}
                      key={credit.id}
                    >
                      <div className="automation-heading">
                        <strong>
                          {credit.title === 'Full reset (Weekly + 5 hr)'
                            ? text('完整重置（周额度 + 5 小时额度）', 'Full reset (Weekly + 5 hr)')
                            : credit.title === 'Rate-limit reset'
                              ? text('额度重置', 'Rate-limit reset')
                              : credit.title || text('额度重置', 'Rate-limit reset')}
                        </strong>
                        <span>
                          {status === 'available'
                            ? text('可用', 'Available')
                            : status === 'used'
                              ? text('已使用', 'Used')
                              : status === 'expired'
                                ? text('已过期', 'Expired')
                                : text('未知状态', 'Unknown status')}
                        </span>
                      </div>
                      <p>
                        {text('到期时间', 'Expires')}：
                        {credit.noExpiry
                          ? text('无到期限制', 'No expiration')
                          : absolute(credit.expiresAt)}
                      </p>
                      <div className="automation-caption">
                        {days !== undefined && days > 0
                          ? text(`剩余 ${days} 天`, `${days} days left`)
                          : null}
                        {account.creditsComplete && credits[0]?.id === credit.id ? (
                          <span className="credit-priority">{text('优先使用', 'Used first')}</span>
                        ) : null}
                      </div>
                    </article>
                  )
                })}
            </div>
            {!account.credits.length && account.creditsComplete ? (
              <p className="automation-caption">
                {text('没有可用的重置卡。', 'No reset credits available.')}
              </p>
            ) : null}
            <button
              className="ghost-button ghost-button--accent"
              type="button"
              disabled={
                disabled ||
                (!snapshot.pendingReset && (!account.creditsComplete || !credits.length))
              }
              onClick={() => {
                void act(() => window.codexStatus.consumeResetCredit(account.key))
              }}
            >
              {snapshot.redeeming
                ? text('处理中…', 'Processing…')
                : snapshot.pendingReset
                  ? text('重试确认本次重置', 'Confirm pending reset')
                  : text('使用重置卡', 'Use reset credit')}
            </button>
            {snapshot.pendingReset ? (
              <p className="automation-caption">
                {text(
                  '上次兑换结果尚未确认，重试会确认同一张卡。',
                  'The previous redemption is unconfirmed. Retrying confirms the same credit.'
                )}
              </p>
            ) : null}
          </>
        ) : !snapshot.issue ? (
          <p className="automation-caption">
            {text('正在读取账号和卡片信息…', 'Loading account and credit information…')}
          </p>
        ) : null}
        {snapshot.resetResult ? (
          <p className="automation-message" role="status">
            {localizedMessage(snapshot.resetResult)}
          </p>
        ) : null}
      </section>
    )

  const edit = (schedule: CycleSchedule): void => {
    setEditing(schedule.id)
    setName(schedule.name)
    setMinutes(String(schedule.windowMinutes))
    setRepeat(schedule.repeat)
    setCustomEvery(String(schedule.customRepeat?.every ?? 1))
    setCustomUnit(schedule.customRepeat?.unit ?? 'weeks')
    setWeekdays(schedule.customRepeat?.weekdays ?? [new Date(schedule.startsAt).getDay()])
    setEndMode(schedule.endsOn ? 'date' : 'never')
    setEndsOn(schedule.endsOn ?? defaultEndDate())
    const date =
      schedule.nextRunAt && Date.parse(schedule.nextRunAt) > now
        ? schedule.nextRunAt
        : new Date(now + 5 * 60000).toISOString()
    setStartsAt(localDateInput(date))
    setIssue('')
  }
  const resetForm = (): void => {
    setEditing(undefined)
    setName('')
    setRepeat('once')
    setCustomEvery('1')
    setCustomUnit('weeks')
    setWeekdays([new Date(Date.now() + 5 * 60000).getDay()])
    setEndMode('never')
    setEndsOn(defaultEndDate())
    setStartsAt(localDateInput(new Date(Date.now() + 5 * 60000).toISOString()))
  }
  const phaseLabel = (phase: string): string =>
    ({
      running: text('执行中', 'Running'),
      started: text('周期已开始', 'Cycle started'),
      unconfirmed: text('周期未确认', 'Unconfirmed'),
      alreadyRunning: text('已在计时，跳过', 'Already running; skipped'),
      failed: text('执行失败', 'Failed'),
      missed: text('错过时间', 'Missed'),
      paused: text('已暂停', 'Paused')
    })[phase] ?? phase
  const dayNames = english
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    : ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const customRepeat: CustomRepeat | undefined =
    repeat === 'custom'
      ? {
          every: Number(customEvery),
          unit: customUnit,
          weekdays: customUnit === 'weeks' ? weekdays : undefined
        }
      : undefined
  const recurrence = {
    startsAt,
    repeat,
    customRepeat,
    endsOn: repeat !== 'once' && endMode === 'date' ? endsOn : undefined
  }
  const nextRun = Date.parse(startsAt) > now ? nextScheduleRun(recurrence, now) : undefined
  const repeatDescription = (schedule: CycleSchedule): string => {
    if (schedule.repeat === 'once') return text('一次', 'Once')
    if (schedule.repeat === 'daily') return text('每天', 'Daily')
    if (schedule.repeat === 'weekly') return text('每周', 'Weekly')
    const rule = schedule.customRepeat!
    const units = {
      minutes: text('分钟', rule.every === 1 ? 'minute' : 'minutes'),
      hours: text('小时', rule.every === 1 ? 'hour' : 'hours'),
      days: text('天', rule.every === 1 ? 'day' : 'days'),
      weeks: text('周', rule.every === 1 ? 'week' : 'weeks')
    }
    return `${text('每隔', 'Every')} ${rule.every} ${units[rule.unit]}${
      rule.unit === 'weeks'
        ? ` · ${[...(rule.weekdays ?? [])]
            .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
            .map((day) => dayNames[day])
            .join(english ? ', ' : '、')}`
        : ''
    }`
  }
  return (
    <section className="automation-section automation-section--schedules">
      <div className="automation-heading">
        <h3>{text('定时任务', 'Schedules')}</h3>
        {refreshButton}
      </div>
      <p className="automation-caption">
        {text(
          '到时间发送一条简短的 Codex 请求，尝试启动额度周期，会消耗少量额度。已在计时的目标周期会跳过。',
          'Send a short Codex request at the scheduled time to start a usage window. This uses a small amount of quota. An active target window is skipped.'
        )}
      </p>
      <p className="automation-caption">
        {text(
          '应用需保持运行，电脑需保持唤醒；错过时间不补发。',
          'Keep the app running and the computer awake. Missed runs are not replayed.'
        )}
      </p>
      {feedback}
      {account ? (
        <p className="automation-caption">
          {account.label} · {account.planType ?? text('订阅未知', 'Unknown plan')}
        </p>
      ) : null}
      <form
        className="schedule-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!account) return
          const date = new Date(startsAt)
          if (!Number.isFinite(date.getTime())) {
            setIssue('请选择执行时间 / Select an execution time')
            return
          }
          void act(() =>
            window.codexStatus.saveSchedule({
              id: editing,
              name: name.trim() || text('额度周期触发', 'Start usage window'),
              accountKey: account.key,
              windowMinutes: Number(minutes),
              startsAt: date.toISOString(),
              repeat,
              customRepeat,
              endsOn: recurrence.endsOn
            })
          ).then((saved) => {
            if (saved && active.current) resetForm()
          })
        }}
      >
        <label>
          {text('任务名称', 'Name')}
          <input
            maxLength={160}
            value={name}
            disabled={busy}
            placeholder={text('额度周期触发', 'Start usage window')}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {text('目标周期', 'Target window')}
          <select
            value={minutes}
            disabled={disabled || !account?.windows.length}
            onChange={(event) => setMinutes(event.target.value)}
          >
            {!account?.windows.length ? (
              <option value="">{text('当前未获取可用周期', 'No windows available')}</option>
            ) : null}
            {[...new Set(account?.windows.map((window) => window.minutes))].map((value) => (
              <option key={value} value={value}>
                {cycleLabel(value, english)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {text('开始时间', 'Start time')}
          <input
            type="datetime-local"
            required
            value={startsAt}
            min={localDateInput(new Date(now).toISOString())}
            disabled={busy}
            onClick={openDatePicker}
            onChange={(event) => setStartsAt(event.target.value)}
          />
          <span className="automation-caption">
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </span>
        </label>
        <div className="schedule-repeat-settings">
          <div className="schedule-repeat-toggle">
            <span>{text('重复执行任务', 'Repeat task')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={repeat !== 'once'}
              aria-label={text('重复执行任务', 'Repeat task')}
              disabled={busy}
              className={`toggle-switch ${repeat !== 'once' ? 'is-checked' : ''}`}
              onClick={() => setRepeat(repeat === 'once' ? 'daily' : 'once')}
            >
              <span className="toggle-switch__track" aria-hidden="true">
                <span className="toggle-switch__thumb" />
              </span>
            </button>
          </div>
          {repeat !== 'once' ? (
            <>
              <label>
                {text('重复', 'Repeat')}
                <select
                  value={repeat}
                  disabled={busy}
                  onChange={(event) => setRepeat(event.target.value as ScheduleRepeat)}
                >
                  <option value="daily">{text('每天', 'Daily')}</option>
                  <option value="weekly">{text('每周', 'Weekly')}</option>
                  <option value="custom">{text('自定义', 'Custom')}</option>
                </select>
              </label>
              {repeat === 'custom' ? (
                <>
                  <div className="schedule-frequency">
                    <label>
                      {text('每隔', 'Every')}
                      <input
                        type="number"
                        required
                        min={1}
                        max={10000}
                        step={1}
                        value={customEvery}
                        disabled={busy}
                        onChange={(event) => setCustomEvery(event.target.value)}
                      />
                    </label>
                    <label>
                      {text('重复单位', 'Frequency')}
                      <select
                        value={customUnit}
                        disabled={busy}
                        onChange={(event) =>
                          setCustomUnit(event.target.value as CustomRepeat['unit'])
                        }
                      >
                        <option value="minutes">{text('分钟', 'Minutes')}</option>
                        <option value="hours">{text('小时', 'Hours')}</option>
                        <option value="days">{text('天', 'Days')}</option>
                        <option value="weeks">{text('周', 'Weeks')}</option>
                      </select>
                    </label>
                  </div>
                  {customUnit === 'weeks' ? (
                    <fieldset className="schedule-weekdays">
                      <legend>{text('执行日', 'Run on')}</legend>
                      <div>
                        {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                          <button
                            key={day}
                            type="button"
                            disabled={busy}
                            aria-pressed={weekdays.includes(day)}
                            onClick={() =>
                              setWeekdays((selected) =>
                                selected.includes(day)
                                  ? selected.filter((value) => value !== day)
                                  : [...selected, day]
                              )
                            }
                          >
                            {dayNames[day]}
                          </button>
                        ))}
                      </div>
                      {!weekdays.length ? (
                        <span className="automation-caption">
                          {text('请选择至少一天。', 'Select at least one day.')}
                        </span>
                      ) : null}
                    </fieldset>
                  ) : null}
                </>
              ) : null}
              <label>
                {text('结束重复', 'End repeat')}
                <select
                  value={endMode}
                  disabled={busy}
                  onChange={(event) => setEndMode(event.target.value as 'never' | 'date')}
                >
                  <option value="never">{text('不结束', 'Never')}</option>
                  <option value="date">{text('指定日期', 'On date')}</option>
                </select>
              </label>
              {endMode === 'date' ? (
                <label>
                  {text('结束日期', 'End date')}
                  <input
                    type="date"
                    required
                    value={endsOn}
                    min={startsAt.slice(0, 10)}
                    disabled={busy}
                    onClick={openDatePicker}
                    onChange={(event) => setEndsOn(event.target.value)}
                  />
                </label>
              ) : null}
            </>
          ) : null}
        </div>
        <p className="automation-caption">
          {nextRun
            ? `${text('下次执行', 'Next run')}：${absolute(nextRun)}`
            : text('请设置有效的未来时间和重复规则。', 'Set a valid future time and recurrence.')}
        </p>
        <div className="schedule-actions">
          <button
            className="ghost-button ghost-button--accent"
            type="submit"
            disabled={
              disabled ||
              !nextRun ||
              !account?.windows.some((window) => String(window.minutes) === minutes)
            }
          >
            {busy
              ? text('处理中…', 'Working…')
              : editing
                ? text('保存修改', 'Save changes')
                : text('添加任务', 'Add schedule')}
          </button>
          {editing ? (
            <button className="ghost-button" type="button" disabled={busy} onClick={resetForm}>
              {text('取消编辑', 'Cancel')}
            </button>
          ) : null}
        </div>
      </form>
      <div className="cycle-schedule-list">
        {snapshot.schedules.map((schedule) => {
          const running = schedule.lastRun?.phase === 'running'
          return (
            <article className="cycle-schedule" key={schedule.id}>
              <div className="automation-heading">
                <strong>{schedule.name}</strong>
                <span>
                  {schedule.enabled ? text('已启用', 'Enabled') : text('已停用', 'Disabled')}
                </span>
              </div>
              <p>
                {cycleLabel(schedule.windowMinutes, english)} · {repeatDescription(schedule)}
              </p>
              <p className="automation-caption">
                {schedule.accountLabel} · {schedule.timeZone}
              </p>
              {schedule.endsOn ? (
                <p className="automation-caption">
                  {text('结束日期', 'Ends on')}：
                  {new Date(`${schedule.endsOn}T12:00:00`).toLocaleDateString(locale)}
                </p>
              ) : null}
              <p>
                {text('下次执行', 'Next run')}：
                {schedule.enabled ? absolute(schedule.nextRunAt) : '—'}
              </p>
              {schedule.lastRun ? (
                <div className="automation-message" role="status">
                  <strong>{phaseLabel(schedule.lastRun.phase)}</strong> ·{' '}
                  {absolute(schedule.lastRun.at)}
                  {schedule.lastRun.message ? (
                    <p>{localizedMessage(schedule.lastRun.message)}</p>
                  ) : null}
                </div>
              ) : null}
              <div className="schedule-actions">
                <button
                  className="ghost-button"
                  type="button"
                  disabled={disabled || running || !account || account.key !== schedule.accountKey}
                  onClick={() => edit(schedule)}
                >
                  {text('编辑', 'Edit')}
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  disabled={
                    disabled ||
                    running ||
                    (!schedule.enabled && (!account || account.key !== schedule.accountKey))
                  }
                  onClick={() => {
                    void act(() =>
                      window.codexStatus.setScheduleEnabled(schedule.id, !schedule.enabled)
                    )
                  }}
                >
                  {schedule.enabled ? text('停用', 'Disable') : text('启用', 'Enable')}
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  disabled={disabled || running}
                  onClick={() => {
                    void act(() => window.codexStatus.deleteSchedule(schedule.id)).then(
                      (removed) => {
                        if (removed && editing === schedule.id && active.current) resetForm()
                      }
                    )
                  }}
                >
                  {text('删除', 'Delete')}
                </button>
              </div>
            </article>
          )
        })}
      </div>
      {!snapshot.schedules.length ? (
        <p className="automation-caption">{text('尚未添加定时任务。', 'No schedules yet.')}</p>
      ) : null}
    </section>
  )
}
