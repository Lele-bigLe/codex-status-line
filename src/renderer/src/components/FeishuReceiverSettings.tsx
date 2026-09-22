import { useEffect, useState } from 'react'
import type { FeishuSettings, FeishuReceiverStatus } from '../../../shared/feishu'

export function FeishuReceiverSettings({
  settings,
  onChange,
  english
}: {
  settings: FeishuSettings
  onChange: (settings: FeishuSettings) => void
  english: boolean
}): React.JSX.Element {
  const [status, setStatus] = useState<FeishuReceiverStatus>({ phase: 'stopped' })
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
          ? 'Uses a self-built app bot. By default, only locates sessions. Enable execution below to chat in one specified test session.'
          : '使用自建应用机器人。默认仅验证定位；开启下方 Codex 执行后，可在指定的测试会话中真实对话。'}
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
        {english ? 'Enable execution in the test session' : '在测试会话中启用真实执行'}
      </label>
      <label className="feishu-field">
        <span>{english ? 'Allowed test session ID' : '允许执行的测试会话 ID'}</span>
        <span className="inline-input inline-input--secret">
          <input
            value={settings.executionThreadId}
            maxLength={128}
            spellCheck={false}
            onChange={(event) => onChange({ ...settings, executionThreadId: event.target.value })}
          />
        </span>
      </label>
      <label className="feishu-field">
        <span>{english ? 'Codex executable (optional)' : 'Codex 可执行文件路径（可选）'}</span>
        <span className="inline-input inline-input--secret">
          <input
            value={settings.codexExecutable}
            maxLength={1024}
            placeholder={
              english ? 'Auto-detect Codex CLI on PATH' : '留空自动查找 PATH 中的 Codex CLI'
            }
            spellCheck={false}
            onChange={(event) => onChange({ ...settings, codexExecutable: event.target.value })}
          />
        </span>
      </label>
      <p className="task-help">
        {english
          ? 'Uses your local Codex login and a read-only sandbox. Answers and questions return here; command approvals require an explicit click. File/permission approvals and sensitive inputs require the computer. Do not run this session in another client at the same time. Saving settings or exiting disconnects the current run.'
          : '使用本机 Codex 登录和只读沙箱。回答、追问会回到飞书，命令审批需明确点击；文件与权限审批、敏感输入需回电脑处理。请勿在其他客户端同时执行这个会话。保存配置或退出程序会断开当前执行连接。'}
      </p>
      <p className="task-help">
        {english
          ? 'After saving, @ the bot with 项目列表, then click a project and a session. Continue by @mentioning the bot without quoting a message. Text commands remain available. Restarting or saving configuration expires menus and bindings; old webhook notifications are not bound.'
          : '保存后在群中 @机器人发送“项目列表”，再点选项目和会话。选定后直接 @机器人发送文字，无需引用旧消息。文字命令仍可使用；重启或保存配置会使旧菜单及绑定失效，原 Webhook 通知不带绑定。'}
      </p>
    </div>
  )
}
