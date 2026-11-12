import { useEffect, useRef, useState } from 'react'
import {
  getCapsuleWindowSize,
  normalizeCapsuleScale,
  REFRESH_INTERVAL_OPTIONS,
  MAX_REFRESH_INTERVAL_SECONDS,
  MIN_REFRESH_INTERVAL_SECONDS,
  type AppSettings,
  type DesktopCapabilities,
  type LocaleCode,
  type PercentageMode
} from '../../../shared/capsule'
import {
  DEFAULT_FEISHU_SETTINGS,
  type FeishuSettings,
  type FeishuStatus
} from '../../../shared/feishu'
import { COPY } from '../copy'
import type { TasksSnapshot } from '../../../shared/tasks'
import { FeishuReceiverSettings } from './FeishuReceiverSettings'
import { GlassMaterial } from './GlassMaterial'
import { ChevronLeftIcon, ChevronRightIcon } from './Icons'

const DEFAULT_CUSTOM_REFRESH_INTERVAL_SECONDS = 40

export function SettingsPanel({
  capabilities,
  settings,
  settingsIssue,
  feishuStatus,
  tasks,
  onSettingsChange,
  onBack,
  onClose
}: {
  capabilities: DesktopCapabilities
  settings: AppSettings
  settingsIssue: boolean
  feishuStatus: FeishuStatus
  tasks: TasksSnapshot
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
  const feishuIssueRef = useRef<HTMLParagraphElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [category, setCategory] = useState<
    'general' | 'appearance' | 'tasks' | 'feishu' | 'receiver'
  >('general')

  useEffect(() => {
    setCustomRefreshInput(String(settings.refreshIntervalSeconds))
  }, [settings.refreshIntervalSeconds])

  useEffect(() => {
    if (!capabilities.feishu) return
    let active = true
    const disposePermission = window.codexStatus.onFeishuPermissionUpdated((grant) => {
      const applyGrant = (previous: FeishuSettings): FeishuSettings => ({
        ...previous,
        executionThreads: [
          ...previous.executionThreads.filter((item) => item.threadId !== grant.threadId),
          grant
        ]
      })
      setFeishuSettings(applyGrant)
      setSavedFeishuSettings(applyGrant)
    })
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
      disposePermission()
    }
  }, [capabilities.feishu])

  const feishuDirty = (Object.keys(DEFAULT_FEISHU_SETTINGS) as (keyof FeishuSettings)[]).some(
    (key) =>
      key === 'executionThreads'
        ? JSON.stringify(feishuSettings[key]) !== JSON.stringify(savedFeishuSettings[key])
        : feishuSettings[key] !== savedFeishuSettings[key]
  )
  const editingFeishu = capabilities.feishu && (category === 'feishu' || category === 'receiver')

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [category])

  useEffect(() => {
    if (editingFeishu && feishuIssue) feishuIssueRef.current?.scrollIntoView({ block: 'nearest' })
  }, [editingFeishu, feishuIssue])
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
      const message =
        error instanceof Error ? error.message : '飞书配置保存失败 / Could not save Feishu settings'
      const parts = message
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
        .split(' / ')
      setFeishuIssue(settings.locale === 'en-US' ? (parts[1] ?? parts[0]) : parts[0])
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
      <nav
        className="settings-categories"
        aria-label={settings.locale === 'en-US' ? 'Settings categories' : '设置分类'}
      >
        {(
          [
            ['general', settings.locale === 'en-US' ? 'General' : '通用', true],
            ['appearance', settings.locale === 'en-US' ? 'Appearance' : '外观', true],
            ['tasks', settings.locale === 'en-US' ? 'Tasks' : '任务通知', capabilities.tasks],
            ['feishu', settings.locale === 'en-US' ? 'Feishu' : '飞书通知', capabilities.feishu],
            [
              'receiver',
              settings.locale === 'en-US' ? 'Feishu bot' : '机器人协作',
              capabilities.feishu
            ]
          ] as const
        )
          .filter(([, , enabled]) => enabled)
          .map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={category === key}
              aria-controls="settings-content"
              onClick={() => setCategory(key)}
            >
              {label}
              {(key === 'feishu' || key === 'receiver') && feishuDirty ? (
                <i aria-label={settings.locale === 'en-US' ? 'Unsaved changes' : '有未保存修改'} />
              ) : null}
            </button>
          ))}
      </nav>
      <div className="panel__content" id="settings-content" ref={contentRef}>
        <div className="panel__header">
          <p className="panel__intro">
            {capabilities.feishu
              ? copy.settingsIntro
              : settings.locale === 'en-US'
                ? 'Settings save automatically.'
                : '设置修改后自动保存。'}
          </p>
        </div>

        {settingsIssue ? (
          <p className="settings-error" role="alert">
            {copy.saveError}
          </p>
        ) : null}
        {editingFeishu && feishuIssue ? (
          <p className="settings-error" role="alert" ref={feishuIssueRef}>
            {feishuIssue}
          </p>
        ) : null}

        <div className="settings-list">
          {capabilities.tasks ? (
            <div className="settings-section glass-surface" hidden={category !== 'tasks'}>
              <GlassMaterial radius={16} />
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
          ) : null}

          {capabilities.feishu ? (
            <>
              <div className="settings-section glass-surface" hidden={category !== 'feishu'}>
                <GlassMaterial radius={16} />
                <p className="settings-section__title">
                  {settings.locale === 'en-US' ? 'Feishu mobile notifications' : '飞书手机通知'}
                </p>
                <fieldset
                  className="feishu-fields"
                  disabled={!feishuLoaded || Boolean(feishuBusy)}
                  aria-busy={Boolean(feishuBusy)}
                  aria-label={settings.locale === 'en-US' ? 'Feishu settings' : '飞书配置'}
                >
                  <div className="feishu-actions">
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => setCategory('receiver')}
                    >
                      {feishuSettings.receiveEnabled
                        ? settings.locale === 'en-US'
                          ? 'Manage collaboration bot'
                          : '管理协作机器人'
                        : settings.locale === 'en-US'
                          ? 'Set up collaboration bot'
                          : '配置协作机器人'}
                    </button>
                  </div>
                  {!feishuSettings.receiveEnabled ? (
                    <p className="task-help">
                      {settings.locale === 'en-US'
                        ? 'Use the collaboration bot for private notifications and tasks. For group notifications only, use the Webhook below.'
                        : '私聊通知和任务协作请配置应用机器人；仅需群通知时可使用下方 Webhook。'}
                    </p>
                  ) : null}
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
                  {(!feishuSettings.receiveEnabled || feishuSettings.receiveMode !== 'p2p') && (
                    <>
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
                          onChange={(mentionAll) =>
                            setFeishuSettings({ ...feishuSettings, mentionAll })
                          }
                        />
                      </div>
                      <p className="task-help">
                        {settings.locale === 'en-US'
                          ? 'Notifications and test messages will mention everyone. Check that the group permits the bot to do so.'
                          : '开启后通知和测试消息都会 @群内所有人；请先确认群允许机器人 @所有人。'}
                      </p>
                    </>
                  )}
                  {feishuSettings.receiveEnabled ? (
                    <p className="task-help">
                      {settings.locale === 'en-US'
                        ? feishuSettings.receiveMode === 'p2p'
                          ? 'Notifications go to your private chat with the collaboration bot.'
                          : 'Notifications use the collaboration bot.'
                        : feishuSettings.receiveMode === 'p2p'
                          ? '通知发送到与协作机器人的私聊。'
                          : '通知统一由协作机器人发送。'}
                    </p>
                  ) : (
                    <>
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
                          {settings.locale === 'en-US'
                            ? 'Signing secret (optional)'
                            : '签名密钥（可选）'}
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
                    </>
                  )}
                  <div className="feishu-actions">
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={
                        feishuDirty ||
                        (!savedFeishuSettings.receiveEnabled && !savedFeishuSettings.webhook)
                      }
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
                  {feishuDirty ? (
                    <p className="task-help">
                      {settings.locale === 'en-US'
                        ? 'Save before testing. The result below is for the saved configuration.'
                        : '请先保存配置再测试；下方发送结果对应已保存配置。'}
                    </p>
                  ) : null}
                </fieldset>
                <p className="task-help">
                  {settings.locale === 'en-US'
                    ? 'Credentials are encrypted on this computer. Question notifications include pending questions; completion notifications include the request and final answer, with previews for long answers. Keep Codex Status running and task monitoring on; the desktop Feishu app need not be signed in.'
                    : '配置加密保存在本机；提问通知显示待回答问题，结束通知包含本轮需求和最终回答，长回答显示预览。需保持本应用运行并开启任务监视，电脑飞书无需登录。'}
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
              </div>
              <div className="settings-section glass-surface" hidden={category !== 'receiver'}>
                <GlassMaterial radius={16} />
                <fieldset
                  className="feishu-fields"
                  disabled={!feishuLoaded || Boolean(feishuBusy)}
                  aria-busy={Boolean(feishuBusy)}
                  aria-label={
                    settings.locale === 'en-US' ? 'Collaboration bot settings' : '协作机器人设置'
                  }
                >
                  {feishuLoaded ? (
                    <FeishuReceiverSettings
                      settings={feishuSettings}
                      savedSettings={savedFeishuSettings}
                      settingsDirty={feishuDirty}
                      tasks={tasks.tasks}
                      monitoring={tasks.monitoring}
                      monitorIssue={tasks.issue}
                      onChange={setFeishuSettings}
                      onOpenTaskSettings={() => setCategory('tasks')}
                      english={settings.locale === 'en-US'}
                    />
                  ) : (
                    <p className="task-help" role="status">
                      {feishuIssue
                        ? settings.locale === 'en-US'
                          ? 'Could not load settings.'
                          : '加载失败'
                        : settings.locale === 'en-US'
                          ? 'Loading bot settings…'
                          : '正在读取机器人配置…'}
                    </p>
                  )}
                </fieldset>
              </div>
            </>
          ) : null}
          <div className="settings-section glass-surface" hidden={category !== 'general'}>
            <GlassMaterial radius={16} />
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

          <div className="settings-section glass-surface" hidden={category !== 'appearance'}>
            <GlassMaterial radius={16} />
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

          {capabilities.launchAtLogin ? (
            <div className="settings-section glass-surface" hidden={category !== 'general'}>
              <GlassMaterial radius={16} />
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
          ) : null}
        </div>
      </div>

      <div className="panel__footer">
        <button className="ghost-button" onClick={onBack} type="button">
          <ChevronLeftIcon />
          <span>{copy.back}</span>
        </button>
        {editingFeishu && savedFeishuSettings.receiveEnabled && feishuDirty ? (
          <p className="task-help settings-save-hint">
            {settings.locale === 'en-US'
              ? 'Saving reconnects the bot. Finish running Feishu tasks first.'
              : '保存会重连机器人，请先结束正在进行的飞书任务。'}
          </p>
        ) : null}
        {editingFeishu ? (
          <button
            className="ghost-button ghost-button--accent"
            type="button"
            disabled={!feishuLoaded || Boolean(feishuBusy) || !feishuDirty}
            onClick={() => {
              void saveFeishuSettings()
            }}
          >
            {feishuBusy === 'save'
              ? settings.locale === 'en-US'
                ? 'Saving…'
                : '保存中…'
              : feishuDirty
                ? category === 'receiver' && feishuSettings.receiveEnabled
                  ? settings.locale === 'en-US'
                    ? 'Save & connect'
                    : '保存并连接'
                  : settings.locale === 'en-US'
                    ? 'Save settings'
                    : '保存配置'
                : settings.locale === 'en-US'
                  ? 'Saved'
                  : '已保存'}
          </button>
        ) : (
          <button className="ghost-button ghost-button--accent" onClick={onClose} type="button">
            <span>{copy.done}</span>
            <ChevronRightIcon />
          </button>
        )}
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
