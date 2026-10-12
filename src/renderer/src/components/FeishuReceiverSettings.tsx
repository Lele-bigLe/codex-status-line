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
  tasks,
  onChange,
  english
}: {
  settings: FeishuSettings
  tasks: TaskRecord[]
  onChange: (settings: FeishuSettings) => void
  english: boolean
}): React.JSX.Element {
  const [status, setStatus] = useState<FeishuReceiverStatus>({ phase: 'stopped' })
  const [threadInput, setThreadInput] = useState('')
  const [grantIssue, setGrantIssue] = useState('')
  const [checking, setChecking] = useState(false)
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
        listening: 'Connected · waiting for a message',
        received: 'Message received · replying…',
        replied: 'Reply accepted by Feishu',
        failed: 'Needs attention'
      }
    : {
        stopped: '接收已关闭',
        starting: '正在连接 / 重连…',
        listening: '连接成功 · 等待消息',
        received: '已收到消息 · 正在回执…',
        replied: '飞书已接收回执',
        failed: '需要处理'
      }
  return (
    <div className="receiver-settings">
      <h3>{english ? 'Feishu conversation · test stage' : '飞书会话交互 · 测试阶段'}</h3>
      <p className="task-help">
        {english
          ? 'Enable execution below, then grant read-only or project-write access in the Feishu session card. You can also manage authorizations here.'
          : '开启下方的执行开关后，可直接在飞书会话卡片中选择“授予只读”或“允许修改项目”；也可在此管理授权。'}
      </p>
      <label className="receiver-toggle">
        <input
          type="checkbox"
          checked={settings.receiveEnabled}
          onChange={(event) => onChange({ ...settings, receiveEnabled: event.target.checked })}
        />
        {english ? 'Enable message reception' : '启用消息接收'}
      </label>
      {(
        [
          ['appId', 'App ID', 'cli_…', false],
          ['appSecret', 'App Secret', '', true],
          ['allowedChatId', english ? 'Allowed group ID' : '允许的群 ID', 'oc_…', false],
          ['allowedUserId', english ? 'Allowed user Open ID' : '允许的用户 Open ID', 'ou_…', false]
        ] as const
      ).map(([key, label, placeholder, secret]) => (
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
        {english
          ? 'Subscribe to im.message.receive_v1 using a long connection. In Callback configuration, also subscribe to card.action.trigger using a long connection for card buttons. Allow group @bot messages and sending as the bot, publish, and enable local task monitoring.'
          : '以长连接订阅消息事件 im.message.receive_v1；在“回调配置”中另以长连接订阅 card.action.trigger，才能使用卡片按钮。开通群内 @消息及机器人发送权限，发布配置，并开启本机任务监视。'}
      </p>
      <div className="receiver-status" role="status">
        <strong>{labels[status.phase]}</strong>
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
        {status.target ? (
          <p>
            {english ? 'Session: ' : '定位会话：'}
            {status.target}
          </p>
        ) : null}
      </div>
      <h3>{english ? 'Codex execution' : 'Codex 执行'}</h3>
      <label className="receiver-toggle">
        <input
          type="checkbox"
          checked={settings.executionEnabled}
          onChange={(event) => onChange({ ...settings, executionEnabled: event.target.checked })}
        />
        {english ? 'Enable execution in authorized sessions' : '在已授权会话中启用真实执行'}
      </label>
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
              (task) => !settings.executionThreads.some((grant) => grant.threadId === task.threadId)
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
              english ? 'Auto-discover installed Codex when empty' : '留空自动查找已安装的 Codex'
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
      <p className="task-help">
        {english
          ? 'New authorizations here default to read only. Project write permits changes inside the session project; approvals show the full command or file diff. Card permission changes are saved for the next turn and require an idle session. Broader permissions require the computer. Sessions execute independently; do not run the same session in another client. Saving settings here disconnects current runs.'
          : '本页新增授权默认只读。项目写入允许修改会话项目内文件；需要审批时展示完整命令或文件差异。卡片授权会保存并用于下一轮，须等当前轮次结束后更改。超出项目的权限需回电脑处理。不同会话独立运行，同一会话请勿同时在其他客户端执行。本页保存配置会断开当前执行连接。'}
      </p>
      <p className="task-help">
        {english
          ? 'After saving, @ the bot with 项目列表, then click a project and a session. Continue by @mentioning the bot without quoting a message. Text commands remain available. Restarting or saving configuration expires menus and bindings; old webhook notifications are not bound.'
          : '保存后在群中 @机器人发送“项目列表”，再点选项目和会话。选定后直接 @机器人发送文字，无需引用旧消息。文字命令仍可使用；重启或保存配置会使旧菜单及绑定失效，原 Webhook 通知不带绑定。'}
      </p>
    </div>
  )
}
