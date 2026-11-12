import { useEffect, useState } from 'react'
import {
  normalizeExecutionThreads,
  type FeishuSettings,
  type FeishuReceiverStatus,
  type CodexRuntimeInfo,
  type CodexPermissionMode
} from '../../../shared/feishu'
import type { TaskRecord } from '../../../shared/tasks'

export function FeishuReceiverSettings({
  settings,
  savedSettings,
  tasks,
  monitoring,
  monitorIssue,
  settingsDirty,
  onChange,
  onOpenTaskSettings,
  english
}: {
  settings: FeishuSettings
  savedSettings: FeishuSettings
  tasks: TaskRecord[]
  monitoring: boolean
  monitorIssue?: string
  settingsDirty: boolean
  onChange: (settings: FeishuSettings) => void
  onOpenTaskSettings: () => void
  english: boolean
}): React.JSX.Element {
  const [status, setStatus] = useState<FeishuReceiverStatus>({ phase: 'stopped' })
  const [threadInput, setThreadInput] = useState('')
  const [grantIssue, setGrantIssue] = useState('')
  const [checking, setChecking] = useState(false)
  const [guideOpen, setGuideOpen] = useState(!savedSettings.appId)
  const [checkResult, setCheckResult] = useState<{
    path: string
    info?: CodexRuntimeInfo
    issue?: string
  }>()
  const addThread = (threadId: string): void => {
    try {
      const executionThreads = normalizeExecutionThreads([
        ...settings.executionThreads,
        { threadId: threadId.trim(), permission: 'read-only' }
      ])
      onChange({ ...settings, executionThreads })
      setThreadInput('')
      setGrantIssue('')
    } catch (error) {
      setGrantIssue(error instanceof Error ? error.message : '会话授权无效。')
    }
  }
  const checkRuntime = async (): Promise<void> => {
    const path = settings.codexExecutable
    setChecking(true)
    try {
      setCheckResult({ path, info: await window.codexStatus.checkCodexRuntime(path) })
    } catch (error) {
      setCheckResult({ path, issue: error instanceof Error ? error.message : '程序检查失败。' })
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    let active = true
    let received = false
    const dispose = window.codexStatus.onFeishuReceiverUpdated((value) => {
      received = true
      setStatus(value)
    })
    void window.codexStatus
      .getFeishuReceiverStatus()
      .then((value) => {
        if (active && !received) setStatus(value)
      })
      .catch(() => {
        if (active)
          setStatus({
            phase: 'failed',
            issue: english ? 'Could not read connection status.' : '无法读取接收状态。'
          })
      })
    return () => {
      active = false
      dispose()
    }
  }, [english])
  const labels = english
    ? {
        stopped: 'Receiver stopped',
        starting: 'Connecting / reconnecting…',
        listening: 'Long connection established · waiting for a message',
        received: 'Message received · replying…',
        replied: 'Reply accepted by Feishu',
        failed: 'Needs attention'
      }
    : {
        stopped: '接收已关闭',
        starting: '正在连接 / 重连…',
        listening: '长连接已建立 · 等待消息',
        received: '已收到消息 · 正在回执…',
        replied: '飞书已接收回执',
        failed: '需要处理'
      }
  return (
    <div className="receiver-settings">
      <h3>{english ? 'Feishu bot collaboration' : '飞书机器人协作'}</h3>
      <section className="receiver-step" aria-labelledby="receiver-connect-title">
        <h4 id="receiver-connect-title">{english ? '1. Connect your bot' : '1. 连接机器人'}</h4>
        <p className="task-help">
          {english ? 'Create an internal app in the ' : '在'}
          <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">
            {english ? 'Feishu developer console' : '飞书开发者后台'}
          </a>
          {english
            ? ', add the Bot capability, then copy App ID and App Secret from Credentials & Basic Info.'
            : '创建企业自建应用，添加“机器人”能力，在“凭证与基础信息”获取 App ID 和 App Secret。'}
        </p>
        <label className="receiver-toggle">
          <input
            type="checkbox"
            checked={settings.receiveEnabled}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? { ...settings, receiveEnabled: true }
                  : { ...settings, receiveEnabled: false, executionEnabled: false, enabled: false }
              )
            }
          />
          {english ? 'Enable bot collaboration' : '启用机器人协作'}
        </label>
        <p className="task-help">
          {english
            ? 'Turning this off and saving also pauses bot execution and completion notifications.'
            : '关闭并保存后，同时暂停机器人执行和飞书完成通知。'}
        </p>
        <fieldset className="feishu-fields" disabled={!settings.receiveEnabled}>
          <label className="feishu-field">
            <span>{english ? 'Conversation type' : '对话方式'}</span>
            <select
              value={settings.receiveMode ?? 'group'}
              onChange={(event) =>
                onChange({
                  ...settings,
                  receiveMode: event.target.value as FeishuSettings['receiveMode']
                })
              }
            >
              <option value="p2p">
                {english ? 'Private chat · recommended, no @mention' : '私聊 · 推荐，无需 @'}
              </option>
              <option value="group">
                {english ? 'Group chat · @mention required' : '群聊 · 需要 @'}
              </option>
            </select>
          </label>
          {(
            [
              ['appId', 'App ID', 'cli_…', false],
              ['appSecret', 'App Secret', '', true],
              ['allowedChatId', english ? 'Allowed group ID' : '允许的群 ID', 'oc_…', false],
              [
                'allowedUserId',
                english ? 'Allowed user Open ID' : '允许的用户 Open ID',
                'ou_…',
                false
              ]
            ] as const
          )
            .filter(([key]) => key !== 'allowedChatId' || settings.receiveMode !== 'p2p')
            .map(([key, label, placeholder, secret]) => (
              <label className="feishu-field" key={key}>
                <span>{label}</span>
                <span className="inline-input inline-input--secret">
                  <input
                    type={secret ? 'password' : 'text'}
                    autoComplete={secret ? 'new-password' : 'off'}
                    spellCheck={false}
                    maxLength={256}
                    value={settings[key]}
                    placeholder={placeholder}
                    onChange={(event) => onChange({ ...settings, [key]: event.target.value })}
                  />
                </span>
              </label>
            ))}
          <p className="task-help">
            <a
              href="https://open.feishu.cn/document/faq/trouble-shooting/how-to-obtain-openid"
              target="_blank"
              rel="noreferrer"
            >
              {english ? 'Get your Open ID' : '如何获取自己的 Open ID'}
            </a>
            {english
              ? ': select this app in API Explorer and copy your own ou_ ID. IDs from another app cannot be used.'
              : '：在 API 调试台选择当前应用，复制自己的 ou_ ID，不能使用其他应用下的 ID。'}
          </p>
        </fieldset>
        <div className="receiver-status" role="status">
          <strong>{labels[status.phase]}</strong>
          {settingsDirty ? (
            <p>
              {english
                ? 'Changes are not saved. This status is for the saved configuration; save to reconnect.'
                : '修改尚未保存；此处为已保存配置的连接状态，保存后重新连接。'}
            </p>
          ) : null}
          {status.issue ? <p className="settings-error">{status.issue}</p> : null}
          {status.receivedAt ? (
            <p>
              {english ? 'Last received: ' : '最近接收：'}
              {new Date(status.receivedAt).toLocaleTimeString()}
            </p>
          ) : null}
          {status.repliedAt ? (
            <p>
              {english ? 'Last reply: ' : '最近回执：'}
              {new Date(status.repliedAt).toLocaleTimeString()}
            </p>
          ) : null}
        </div>
        <label className="receiver-toggle">
          <input
            type="checkbox"
            disabled={!settings.receiveEnabled}
            checked={settings.executionEnabled}
            onChange={(event) => onChange({ ...settings, executionEnabled: event.target.checked })}
          />
          {english ? 'Allow Codex tasks from Feishu' : '允许从飞书执行 Codex 任务'}
        </label>
        <p className="task-help">
          {english
            ? 'Each session still needs permission in its Details card: read only for questions, or project write to edit project files.'
            : '开启后仍需在会话“详情”中授权：只读用于问答，项目写入允许修改项目文件。'}
        </p>
      </section>

      <details
        className="receiver-guide"
        open={guideOpen}
        onToggle={(event) => setGuideOpen(event.currentTarget.open)}
      >
        <summary>
          {english ? '2. Set permissions, events and publish' : '2. 配置权限、事件并发布'}
        </summary>
        <div className="receiver-guide__body">
          <p className="task-help">
            {english
              ? 'In Permissions, enable these app permissions for the selected conversation type:'
              : '在飞书后台“权限管理”中，按所选对话方式开通以下应用身份权限：'}
          </p>
          <ul className="receiver-instructions">
            <li>
              {settings.receiveMode === 'p2p'
                ? english
                  ? 'Receive private messages'
                  : '接收私聊消息'
                : english
                  ? 'Receive group @mentions'
                  : '接收群聊中 @机器人的消息'}
              <code>
                {settings.receiveMode === 'p2p'
                  ? 'im:message.p2p_msg:readonly'
                  : 'im:message.group_at_msg:readonly'}
              </code>
            </li>
            <li>
              {english ? 'Send as the app bot' : '以应用机器人身份发送消息'}
              <code>im:message:send_as_bot</code>
            </li>
          </ul>
          <ol className="receiver-instructions">
            <li>
              {english
                ? 'Save the connection settings on this page. Keep this app running if the console says no long connection is established.'
                : '先保存本页连接信息；后台提示“未建立长连接”时，保持本应用运行并等待连接建立。'}
            </li>
            <li>
              {english
                ? 'Events & Callbacks → Event configuration: choose long connection and add Receive message.'
                : '“事件与回调 → 事件配置”：选择长连接，添加“接收消息”。'}
              <code>im.message.receive_v1</code>
            </li>
            <li>
              {english
                ? 'Callback configuration: also choose long connection and add Card action callback. This enables dropdowns and buttons.'
                : '“回调配置”：也选择长连接，添加“卡片回传交互”，下拉框和按钮才能响应。'}
              <code>card.action.trigger</code>
            </li>
            <li>
              {english
                ? 'In Version Management & Release, create a version, include yourself in availability, and publish. Wait for admin approval if required. Republish changes to permissions and events.'
                : '在“版本管理与发布”创建版本，将自己加入可用范围并发布；如需管理员审核，等待通过。修改权限或事件后也需发布。'}
            </li>
            {settings.receiveMode !== 'p2p' ? (
              <li>
                {english
                  ? 'Add the published bot to the group whose oc_ ID you configured above.'
                  : '将已发布的机器人加入上方 oc_ ID 对应的群。'}
              </li>
            ) : null}
          </ol>
          <p className="task-help">
            <a
              href="https://open.feishu.cn/document/server-docs/im-v1/message/events/receive"
              target="_blank"
              rel="noreferrer"
            >
              {english ? 'Message event reference' : '接收消息说明'}
            </a>
            {' · '}
            <a
              href="https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks"
              target="_blank"
              rel="noreferrer"
            >
              {english ? 'Card callback setup' : '卡片回调配置说明'}
            </a>
          </p>
        </div>
      </details>

      <section className="receiver-step" aria-labelledby="receiver-start-title">
        <h4 id="receiver-start-title">{english ? '3. Start a conversation' : '3. 开始使用'}</h4>
        {monitorIssue ? (
          <p className="settings-error" role="alert">
            {monitorIssue}
          </p>
        ) : null}
        {!monitoring ? (
          <div className="receiver-status">
            <p>
              {english
                ? 'Enable local task monitoring so the bot can list projects and sessions.'
                : '先开启本机任务监视，机器人才能列出项目和会话。'}
            </p>
            <button className="ghost-button" type="button" onClick={onOpenTaskSettings}>
              {english ? 'Open task settings' : '前往开启任务监视'}
            </button>
          </div>
        ) : null}
        <ol className="receiver-instructions">
          <li>
            {english
              ? 'Make sure Codex works on your computer. Open a project there and send a message so monitoring can discover it.'
              : '先确认电脑上的 Codex 可正常对话。在目标项目中发起一次对话，等待任务监视发现。'}
          </li>
          <li>
            {settings.receiveMode === 'p2p'
              ? english
                ? 'Find the app by name in mobile Feishu, open the bot chat, and send '
                : '在手机飞书搜索应用名称，打开机器人私聊并发送 '
              : english
                ? 'In the configured group, @mention the bot and send '
                : '在配置的群中 @机器人发送 '}
            <code className="receiver-command">项目列表</code>
          </li>
          <li>
            {english
              ? 'Use the project and session dropdowns. After enabling execution and saving, New session creates another conversation in the selected project.'
              : '在下拉框中选择项目和会话；开启并保存执行开关后，“新建会话”可在已选项目另开会话。'}
          </li>
          <li>
            {settings.executionEnabled
              ? english
                ? 'Open Details, grant read-only or project-write permission, then send your request.'
                : '打开会话“详情”，授予只读或项目写入权限，再发送需求。'
              : english
                ? 'To run tasks, enable Allow Codex tasks above and save, then grant permission in the session Details card.'
                : '需要执行任务时，先开启上方执行开关并保存，再到会话“详情”中授权。'}
          </li>
        </ol>
        <p className="task-help">
          {english
            ? 'Keep this app running. Returning to a project restores its last available session. Context and actions are separate; sessions in the same project share files.'
            : '使用时保持本应用运行。切回项目会恢复上次有效会话；上下文和操作独立，同项目会话仍共用文件。'}
        </p>
      </section>

      <details className="receiver-guide">
        <summary>
          {english ? 'Session permissions & program settings' : '会话授权与程序设置'}
          {` (${settings.executionThreads.length})`}
        </summary>
        <div className="receiver-guide__body">
          {settings.executionThreads.map((grant, index) => {
            const task = tasks.find((item) => item.threadId === grant.threadId)
            return (
              <div className="session-grant" key={grant.threadId}>
                <strong>{task?.title || grant.threadId}</strong>
                <small>
                  {task?.cwd ? `${task.cwd}\n` : ''}
                  {grant.threadId}
                </small>
                <div className="session-grant__actions">
                  <select
                    aria-label={`${english ? 'Permissions' : '会话权限'} ${task?.title || grant.threadId}`}
                    value={grant.permission}
                    onChange={(event) =>
                      onChange({
                        ...settings,
                        executionThreads: settings.executionThreads.map((item, position) =>
                          position === index
                            ? { ...item, permission: event.target.value as CodexPermissionMode }
                            : item
                        )
                      })
                    }
                  >
                    <option value="read-only">
                      {english ? 'Read only · ask when needed' : '只读 · 必要时审批'}
                    </option>
                    <option value="workspace-write">
                      {english ? 'Project write · ask when needed' : '项目写入 · 必要时审批'}
                    </option>
                  </select>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      onChange({
                        ...settings,
                        executionThreads: settings.executionThreads.filter(
                          (item) => item.threadId !== grant.threadId
                        )
                      })
                    }
                  >
                    {english ? 'Remove' : '移除授权'}
                  </button>
                </div>
              </div>
            )
          })}
          <label className="feishu-field">
            <span>{english ? 'Authorize a monitored session' : '从监视列表添加会话'}</span>
            <select
              value=""
              onChange={(event) => {
                if (event.target.value) addThread(event.target.value)
              }}
            >
              <option value="">{english ? 'Choose a session…' : '选择要授权的会话…'}</option>
              {tasks
                .filter(
                  (task) =>
                    !settings.executionThreads.some((grant) => grant.threadId === task.threadId)
                )
                .map((task) => (
                  <option key={task.threadId} value={task.threadId}>
                    {task.title || task.threadId} · {task.cwd}
                  </option>
                ))}
            </select>
          </label>
          <div className="session-grant__actions">
            <label className="inline-input inline-input--secret">
              <input
                aria-label={english ? 'Session ID' : '手动填写会话 ID'}
                placeholder={english ? 'Or enter a session ID' : '也可以粘贴会话 ID'}
                value={threadInput}
                maxLength={128}
                onChange={(event) => setThreadInput(event.target.value)}
              />
            </label>
            <button
              className="ghost-button"
              type="button"
              disabled={!threadInput.trim()}
              onClick={() => addThread(threadInput)}
            >
              {english ? 'Add' : '添加'}
            </button>
          </div>
          {grantIssue ? (
            <p className="settings-error" role="alert">
              {grantIssue}
            </p>
          ) : null}
          <label className="feishu-field">
            <span>{english ? 'Codex executable (optional)' : 'Codex 可执行文件路径（可选）'}</span>
            <span className="inline-input inline-input--secret">
              <input
                value={settings.codexExecutable}
                maxLength={1024}
                placeholder={
                  english
                    ? 'Auto-discover installed Codex when empty'
                    : '留空自动查找已安装的 Codex'
                }
                spellCheck={false}
                onChange={(event) => onChange({ ...settings, codexExecutable: event.target.value })}
              />
            </span>
          </label>
          <div className="feishu-actions">
            <button
              className="ghost-button"
              type="button"
              disabled={checking || !settings.codexExecutable}
              onClick={() => onChange({ ...settings, codexExecutable: '' })}
            >
              {english ? 'Use auto-discovery' : '使用自动查找'}
            </button>
            <button
              className="ghost-button ghost-button--accent"
              type="button"
              disabled={checking}
              onClick={() => {
                void checkRuntime()
              }}
            >
              {checking
                ? english
                  ? 'Checking…'
                  : '检查中…'
                : english
                  ? 'Check program'
                  : '检查程序与协议'}
            </button>
          </div>
          {checkResult?.path === settings.codexExecutable ? (
            <div className="receiver-status" role="status">
              {checkResult.issue ? (
                <p className="settings-error">{checkResult.issue}</p>
              ) : (
                <>
                  <strong>{english ? 'Protocol connected' : '基础协议连接成功'}</strong>
                  <p>{checkResult.info?.version}</p>
                  <p>{checkResult.info?.executable}</p>
                  <p>
                    {english
                      ? 'No task submitted. Session compatibility is checked before execution.'
                      : '未提交任务；具体会话会在执行前检查恢复兼容性。'}
                  </p>
                </>
              )}
            </div>
          ) : null}
          {status.codexRuntime ? (
            <p className="task-help">
              {english ? 'Last execution program: ' : '最近执行程序：'}
              {status.codexRuntime.version}
              <br />
              {status.codexRuntime.executable}
            </p>
          ) : null}
          {status.target ? (
            <p className="task-help">
              {english ? 'Last selected session: ' : '最近定位会话：'}
              {status.target}
            </p>
          ) : null}
          <p className="task-help">
            {english
              ? 'New authorizations here are read only. Approvals show full commands or diffs. Change permissions between turns and avoid running the same session in another client.'
              : '本页新增授权默认只读；审批完整展示命令或差异。请在轮次结束后更改权限，同一会话勿在其他客户端同时执行。'}
          </p>
          <p className="task-help">
            {english
              ? 'After restarting or saving settings, send 项目列表 to create a new menu. Old buttons expire; project-session memory is kept for the same app, user and chat.'
              : '重启或重新保存配置后，发送“项目列表”重建菜单；旧按钮过期，同一应用、用户和聊天的项目记忆可恢复。'}
          </p>
        </div>
      </details>
    </div>
  )
}
