import { useEffect, useState } from 'react'
import {
  getCapsuleWindowSize,
  normalizeCapsuleScale,
  REFRESH_INTERVAL_OPTIONS,
  MAX_REFRESH_INTERVAL_SECONDS,
  MIN_REFRESH_INTERVAL_SECONDS,
  type AppSettings,
  type LocaleCode,
  type PercentageMode
} from '../../../shared/capsule'
import {
  DEFAULT_FEISHU_SETTINGS,
  type FeishuSettings,
  type FeishuStatus
} from '../../../shared/feishu'
import { COPY } from '../copy'
import { ChevronLeftIcon, ChevronRightIcon } from './Icons'

const DEFAULT_CUSTOM_REFRESH_INTERVAL_SECONDS = 40

export function SettingsPanel({
  settings,
  settingsIssue,
  feishuStatus,
  onSettingsChange,
  onBack,
  onClose
}: {
  settings: AppSettings
  settingsIssue: boolean
  feishuStatus: FeishuStatus
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
  onBack: () => void
  onClose: () => void
}): React.JSX.Element {
  const copy = COPY[settings.locale]
  const [customRefreshInput, setCustomRefreshInput] = useState(
    String(settings.refreshIntervalSeconds)
  )
  const [feishuSettings, setFeishuSettings] = useState<FeishuSettings>({
    ...DEFAULT_FEISHU_SETTINGS
  })
  const [savedFeishuSettings, setSavedFeishuSettings] = useState<FeishuSettings>({
    ...DEFAULT_FEISHU_SETTINGS
  })
  const [feishuLoaded, setFeishuLoaded] = useState(false)
  const [feishuBusy, setFeishuBusy] = useState<'save' | 'test' | undefined>()
  const [feishuIssue, setFeishuIssue] = useState('')

  useEffect(() => {
    setCustomRefreshInput(String(settings.refreshIntervalSeconds))
  }, [settings.refreshIntervalSeconds])

  useEffect(() => {
    let active = true
    void window.codexStatus
      .getFeishuSettings()
      .then((value) => {
        if (!active) return
        setFeishuSettings(value)
        setSavedFeishuSettings(value)
        setFeishuLoaded(true)
      })
      .catch(() => {
        if (active)
          setFeishuIssue('飞书配置读取失败，请重新打开设置 / Could not load Feishu settings')
      })
    return () => {
      active = false
    }
  }, [])

  const feishuDirty =
    feishuSettings.enabled !== savedFeishuSettings.enabled ||
    feishuSettings.mentionAll !== savedFeishuSettings.mentionAll ||
    feishuSettings.webhook !== savedFeishuSettings.webhook ||
    feishuSettings.secret !== savedFeishuSettings.secret
  const isCustomRefreshInterval = !REFRESH_INTERVAL_OPTIONS.some(
    (option) => option === settings.refreshIntervalSeconds
  )
  const intervalControlValue = isCustomRefreshInterval
    ? 'custom'
    : String(settings.refreshIntervalSeconds)
  const canEditCustomRefresh = settings.refreshMode === 'auto' && isCustomRefreshInterval

  async function saveFeishuSettings(): Promise<void> {
    setFeishuBusy('save')
    setFeishuIssue('')
    try {
      const value = await window.codexStatus.saveFeishuSettings(feishuSettings)
      setFeishuSettings(value)
      setSavedFeishuSettings(value)
    } catch (error) {
      setFeishuIssue(
        error instanceof Error ? error.message : '飞书配置保存失败 / Could not save Feishu settings'
      )
    } finally {
      setFeishuBusy(undefined)
    }
  }

  async function testFeishuNotification(): Promise<void> {
    setFeishuBusy('test')
    setFeishuIssue('')
    try {
      await window.codexStatus.testFeishuNotification()
    } catch {
      setFeishuIssue('无法发送测试通知，请重试 / Could not send the test notification')
    } finally {
      setFeishuBusy(undefined)
    }
  }

  function commitCustomRefreshInterval(): void {
    if (!canEditCustomRefresh) {
      setCustomRefreshInput(String(settings.refreshIntervalSeconds))
      return
    }

    const parsed = Number.parseInt(customRefreshInput, 10)
    if (!Number.isFinite(parsed)) {
      setCustomRefreshInput(String(settings.refreshIntervalSeconds))
      return
    }

    const normalized = normalizeCustomRefreshInterval(parsed)
    setCustomRefreshInput(String(normalized))
    if (normalized !== settings.refreshIntervalSeconds) {
      void onSettingsChange({ refreshIntervalSeconds: normalized })
    }
  }

  function selectRefreshInterval(value: string): void {
    if (value === 'custom') {
      const parsed = Number.parseInt(customRefreshInput, 10)
      const candidate = Number.isFinite(parsed)
        ? normalizeCustomRefreshInterval(parsed)
        : DEFAULT_CUSTOM_REFRESH_INTERVAL_SECONDS
      const nextValue = isFixedRefreshInterval(candidate)
        ? DEFAULT_CUSTOM_REFRESH_INTERVAL_SECONDS
        : candidate

      setCustomRefreshInput(String(nextValue))
      void onSettingsChange({ refreshIntervalSeconds: nextValue })
      return
    }

    const nextValue = Number(value)
    setCustomRefreshInput(String(nextValue))
    void onSettingsChange({
      refreshIntervalSeconds: nextValue
    })
  }

  return (
    <div className="panel__body panel__body--settings">
      <div className="panel__content">
        <div className="panel__header">
          <p className="panel__intro">{copy.settingsIntro}</p>
        </div>

        {settingsIssue ? (
          <p className="settings-error" role="alert">
            {copy.saveError}
          </p>
        ) : null}

        <div className="settings-list">
          <div className="settings-section">
            <p className="settings-section__title">
              {settings.locale === 'en-US' ? 'Tasks & notifications' : '任务与通知'}
            </p>
            {(
              [
                [
                  'taskMonitoring',
                  settings.locale === 'en-US' ? 'Monitor local tasks' : '本机任务监视'
                ],
                [
                  'taskNotifications',
                  settings.locale === 'en-US' ? 'Desktop notifications' : '桌面状态通知'
                ],
                [
                  'taskNotificationSound',
                  settings.locale === 'en-US' ? 'Desktop notification sound' : '桌面通知声音'
                ]
              ] as const
            ).map(([key, label]) => (
              <div className="setting-row" key={key}>
                <span>{label}</span>
                <ToggleSwitch
                  checked={settings[key]}
                  label={label}
                  offLabel={copy.disabled}
                  onLabel={copy.enabled}
                  onChange={(checked) => {
                    void onSettingsChange({ [key]: checked })
                  }}
                />
              </div>
            ))}
            <p className="task-help">
              {settings.locale === 'en-US'
                ? 'Notify when Codex asks a question or a turn ends. Desktop notifications require OS permission. Desktop and Feishu switches are independent; muted or removed sessions and historical events do not notify.'
                : 'Codex 提问或轮次结束时提醒，通知包含问题或本轮需求摘要。桌面通知需系统允许，桌面与飞书分别开关；静音或移除的会话不提醒，重启监视不补发历史通知。'}
            </p>
          </div>
          <div className="settings-section">
            <p className="settings-section__title">
              {settings.locale === 'en-US' ? 'Feishu mobile notifications' : '飞书手机通知'}
            </p>
            <fieldset
              className="feishu-fields"
              disabled={!feishuLoaded || Boolean(feishuBusy)}
              aria-busy={Boolean(feishuBusy)}
              aria-label={settings.locale === 'en-US' ? 'Feishu settings' : '飞书配置'}
            >
              <div className="setting-row">
                <span>
                  {settings.locale === 'en-US'
                    ? 'Notify on questions and turn end'
                    : '提问及轮次结束时推送'}
                </span>
                <ToggleSwitch
                  checked={feishuSettings.enabled}
                  label={settings.locale === 'en-US' ? 'Feishu notifications' : '飞书通知'}
                  offLabel={copy.disabled}
                  onLabel={copy.enabled}
                  onChange={(enabled) => setFeishuSettings({ ...feishuSettings, enabled })}
                />
              </div>
              <div className="setting-row">
                <span>
                  {settings.locale === 'en-US'
                    ? 'Mention everyone in notifications'
                    : '通知时 @所有人'}
                </span>
                <ToggleSwitch
                  checked={feishuSettings.mentionAll}
                  label={
                    settings.locale === 'en-US'
                      ? 'Mention everyone in notifications'
                      : '通知时 @所有人'
                  }
                  offLabel={copy.disabled}
                  onLabel={copy.enabled}
                  onChange={(mentionAll) => setFeishuSettings({ ...feishuSettings, mentionAll })}
                />
              </div>
              <p className="task-help">
                {settings.locale === 'en-US'
                  ? 'For a personal notification group, enable this to mention yourself without a user ID. The group must allow the bot to mention everyone. Test notifications also mention everyone.'
                  : '个人通知群可开启，无需填写用户 ID；群内需允许机器人 @所有人，测试通知也会 @所有人。'}
              </p>
              <label className="feishu-field">
                <span>{settings.locale === 'en-US' ? 'Webhook URL' : 'Webhook 地址'}</span>
                <span className="inline-input inline-input--secret">
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={512}
                    placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
                    value={feishuSettings.webhook}
                    onChange={(event) =>
                      setFeishuSettings({ ...feishuSettings, webhook: event.target.value })
                    }
                  />
                </span>
              </label>
              <label className="feishu-field">
                <span>
                  {settings.locale === 'en-US' ? 'Signing secret (optional)' : '签名密钥（可选）'}
                </span>
                <span className="inline-input inline-input--secret">
                  <input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    maxLength={256}
                    placeholder={
                      settings.locale === 'en-US'
                        ? 'Required if signature verification is enabled'
                        : '机器人开启签名校验时必填'
                    }
                    value={feishuSettings.secret}
                    onChange={(event) =>
                      setFeishuSettings({ ...feishuSettings, secret: event.target.value })
                    }
                  />
                </span>
              </label>
              <div className="feishu-actions">
                <button
                  className="ghost-button ghost-button--accent"
                  type="button"
                  disabled={!feishuDirty}
                  onClick={() => {
                    void saveFeishuSettings()
                  }}
                >
                  {feishuBusy === 'save'
                    ? settings.locale === 'en-US'
                      ? 'Saving…'
                      : '保存中…'
                    : feishuDirty
                      ? settings.locale === 'en-US'
                        ? 'Save settings'
                        : '保存配置'
                      : settings.locale === 'en-US'
                        ? 'Saved'
                        : '已保存'}
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  disabled={feishuDirty || !savedFeishuSettings.webhook}
                  onClick={() => {
                    void testFeishuNotification()
                  }}
                >
                  {feishuBusy === 'test'
                    ? settings.locale === 'en-US'
                      ? 'Sending…'
                      : '发送中…'
                    : settings.locale === 'en-US'
                      ? 'Send test notification'
                      : '发送测试通知'}
                </button>
              </div>
            </fieldset>
            <p className="task-help">
              {settings.locale === 'en-US'
                ? 'Credentials are encrypted on this computer. Enabling sends titles, questions and request summaries to your Feishu group. Keep Codex Status running and task monitoring on; the desktop Feishu app need not be signed in.'
                : '地址与密钥加密保存在本机；开启后会将标题、待回答的问题及需求摘要发送到指定飞书群。需保持本应用运行并开启任务监视，电脑飞书无需登录。'}
            </p>
            {feishuStatus.enabled && !settings.taskMonitoring ? (
              <p className="settings-error" role="status">
                {settings.locale === 'en-US'
                  ? 'Task monitoring is paused; automatic notifications are paused too.'
                  : '任务监视已关闭，自动推送也已暂停。'}
              </p>
            ) : null}
            <p
              className={`task-help${feishuStatus.phase === 'failed' ? ' settings-error' : ''}`}
              role="status"
            >
              {feishuStatus.phase === 'sending'
                ? settings.locale === 'en-US'
                  ? 'Sending to Feishu…'
                  : '正在发送到飞书…'
                : feishuStatus.phase === 'sent'
                  ? settings.locale === 'en-US'
                    ? 'Accepted by Feishu; check your phone.'
                    : '飞书已接收，请检查手机通知。'
                  : feishuStatus.phase === 'failed'
                    ? feishuStatus.issue
                    : settings.locale === 'en-US'
                      ? 'No notifications sent with this configuration yet.'
                      : '当前配置尚未发送通知。'}
              {feishuStatus.updatedAt
                ? ` · ${new Date(feishuStatus.updatedAt).toLocaleTimeString(settings.locale)}`
                : ''}
            </p>
            {feishuIssue ? (
              <p className="settings-error" role="alert">
                {feishuIssue}
              </p>
            ) : null}
          </div>
          <div className="settings-section">
            <p className="settings-section__title">{copy.groupRefresh}</p>
            <SettingField label={copy.refreshMode}>
              <SegmentedControl
                onChange={(value) => {
                  void onSettingsChange({
                    refreshMode: value as AppSettings['refreshMode']
                  })
                }}
                options={[
                  { label: copy.auto, value: 'auto' },
                  { label: copy.manual, value: 'manual' }
                ]}
                value={settings.refreshMode}
              />
            </SettingField>

            <SettingField label={copy.refreshInterval}>
              <div className="setting-stack">
                <SegmentedControl
                  disabled={settings.refreshMode === 'manual'}
                  onChange={selectRefreshInterval}
                  options={[
                    ...REFRESH_INTERVAL_OPTIONS.map((option) => ({
                      label: `${option}s`,
                      value: String(option)
                    })),
                    { label: copy.custom, value: 'custom' }
                  ]}
                  value={intervalControlValue}
                />
                {intervalControlValue === 'custom' ? (
                  <label
                    className={`inline-input ${canEditCustomRefresh ? 'is-active' : 'is-disabled'}`}
                  >
                    <span>{copy.customInterval}</span>
                    <input
                      disabled={!canEditCustomRefresh}
                      max={MAX_REFRESH_INTERVAL_SECONDS}
                      min={MIN_REFRESH_INTERVAL_SECONDS}
                      onBlur={commitCustomRefreshInterval}
                      onChange={(event) => {
                        setCustomRefreshInput(event.target.value)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.currentTarget.blur()
                        }
                      }}
                      step={1}
                      type="number"
                      value={customRefreshInput}
                    />
                    <em>s</em>
                  </label>
                ) : null}
              </div>
            </SettingField>
          </div>

          <div className="settings-section">
            <p className="settings-section__title">{copy.groupDisplay}</p>
            <SettingField label={copy.theme}>
              <SegmentedControl
                value={settings.theme}
                options={[
                  { label: copy.lightTheme, value: 'light' },
                  { label: copy.darkTheme, value: 'dark' }
                ]}
                onChange={(value) => {
                  void onSettingsChange({ theme: value as AppSettings['theme'] })
                }}
              />
            </SettingField>
            <SettingField label={copy.displayMode}>
              <SegmentedControl
                onChange={(value) => {
                  void onSettingsChange({ displayMode: value as AppSettings['displayMode'] })
                }}
                options={[
                  { label: copy.floatingMode, value: 'floating' },
                  { label: copy.trayMode, value: 'tray' }
                ]}
                value={settings.displayMode}
              />
            </SettingField>

            <SettingField label={copy.capsuleScale}>
              <div className="setting-stack">
                <SegmentedControl
                  value={String(settings.capsuleScale)}
                  options={[100, 125, 150, 200].map((scale) => ({
                    label: `${scale}%`,
                    value: String(scale)
                  }))}
                  onChange={(value) => {
                    void onSettingsChange({ capsuleScale: Number(value) })
                  }}
                />
                <label className="inline-input inline-input--scale">
                  <input
                    key={settings.capsuleScale}
                    type="number"
                    aria-label={copy.capsuleScale}
                    min={100}
                    max={300}
                    step={1}
                    defaultValue={settings.capsuleScale}
                    onBlur={(event) => {
                      const value = event.currentTarget.valueAsNumber
                      const scale = Number.isFinite(value)
                        ? normalizeCapsuleScale(value)
                        : settings.capsuleScale
                      event.currentTarget.value = String(scale)
                      if (scale !== settings.capsuleScale)
                        void onSettingsChange({ capsuleScale: scale })
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                  />
                  <em>%</em>
                </label>
                <p className="quota-card__date">
                  {copy.capsuleScaleHint}{' '}
                  {getCapsuleWindowSize('capsule', settings.capsuleScale).width} ×{' '}
                  {getCapsuleWindowSize('capsule', settings.capsuleScale).height}
                </p>
              </div>
            </SettingField>

            <SettingField label={copy.percentageMode}>
              <SegmentedControl
                onChange={(value) => {
                  void onSettingsChange({
                    percentageMode: value as PercentageMode
                  })
                }}
                options={[
                  { label: copy.remaining, value: 'remaining' },
                  { label: copy.used, value: 'used' }
                ]}
                value={settings.percentageMode}
              />
            </SettingField>

            <SettingField label={copy.language}>
              <SegmentedControl
                onChange={(value) => {
                  void onSettingsChange({
                    locale: value as LocaleCode
                  })
                }}
                options={[
                  { label: '简中', value: 'zh-CN' },
                  { label: 'English', value: 'en-US' }
                ]}
                value={settings.locale}
              />
            </SettingField>
          </div>

          <div className="settings-section">
            <p className="settings-section__title">{copy.groupGeneral}</p>
            <div className="setting-row">
              <span>{copy.launchAtLogin}</span>
              <ToggleSwitch
                checked={settings.launchAtLogin}
                label={copy.launchAtLogin}
                offLabel={copy.disabled}
                onChange={(checked) => {
                  void onSettingsChange({ launchAtLogin: checked })
                }}
                onLabel={copy.enabled}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="panel__footer">
        <button className="ghost-button" onClick={onBack} type="button">
          <ChevronLeftIcon />
          <span>{copy.back}</span>
        </button>
        <button className="ghost-button ghost-button--accent" onClick={onClose} type="button">
          <span>{copy.done}</span>
          <ChevronRightIcon />
        </button>
      </div>
    </div>
  )
}

function SettingField({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="setting-field" role="group" aria-label={label}>
      <span className="setting-field__label">{label}</span>
      {children}
    </div>
  )
}

function SegmentedControl({
  value,
  options,
  onChange,
  disabled
}: {
  value: string
  options: Array<{ label: string; value: string }>
  onChange: (value: string) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className={`segmented ${disabled ? 'is-disabled' : ''}`}>
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={option.value === value ? 'is-active' : ''}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function ToggleSwitch({
  checked,
  onChange,
  onLabel,
  offLabel,
  label
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  onLabel: string
  offLabel: string
  label: string
}): React.JSX.Element {
  return (
    <button
      aria-checked={checked}
      aria-label={`${label}: ${checked ? onLabel : offLabel}`}
      className={`toggle-switch ${checked ? 'is-checked' : ''}`}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span className="toggle-switch__track" aria-hidden="true">
        <span className="toggle-switch__thumb" />
      </span>
    </button>
  )
}

function normalizeCustomRefreshInterval(value: number): number {
  return Math.min(
    MAX_REFRESH_INTERVAL_SECONDS,
    Math.max(MIN_REFRESH_INTERVAL_SECONDS, Math.round(value))
  )
}

function isFixedRefreshInterval(value: number): boolean {
  return REFRESH_INTERVAL_OPTIONS.some((option) => option === value)
}
