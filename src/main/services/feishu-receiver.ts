import { Client, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  FeishuSettings,
  FeishuReceiverStatus,
  ExecutionThread,
  CodexSessionConfiguration
} from '../../shared/feishu'
import type { TasksSnapshot, TaskRecord } from '../../shared/tasks'
import { FeishuRouter, type RouteAction, type RouteReply } from './feishu-routing'
import { CodexSession } from './codex-session'

// SDK 的异常可能包含带凭据的请求对象，统一使用脱敏状态反馈。
const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} }

interface CardActionEvent {
  token?: string
  operator?: { open_id?: string }
  context?: { open_chat_id?: string; open_message_id?: string }
  action?: { value?: { actionId?: unknown } }
}

function configurationText(configuration?: CodexSessionConfiguration, current = false): string {
  if (!configuration) return '模型：待确认 · 思考程度：待确认（连接后读取）'
  const efforts: Record<string, string> = {
    none: '无',
    minimal: '最低',
    low: '低',
    medium: '中等',
    high: '高',
    xhigh: '极高',
    max: '最高',
    ultra: '超高'
  }
  const effort = configuration.reasoningEffort
  const label =
    effort === null ? '默认（未返回具体档位）' : effort ? (efforts[effort] ?? effort) : '未返回'
  return `${current ? '本轮配置' : '最近确认'} · 模型：${configuration.model || '未返回'} · 思考程度：${label}`
}

function selectionCard(reply: RouteReply): {
  card: object
  actions: Map<string, RouteAction>
} {
  const actions = new Map<string, RouteAction>()
  const button = (label: string, action: RouteAction): object => {
    const actionId = randomUUID()
    actions.set(actionId, action)
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      value: { actionId },
      type: 'default'
    }
  }
  return {
    actions,
    card: {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: reply.title ?? 'Codex 会话选择' },
        template: 'blue'
      },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: reply.cardText ?? reply.text } },
        ...(reply.sessionInfo
          ? [{ tag: 'note', elements: [{ tag: 'plain_text', content: reply.sessionInfo }] }]
          : []),
        ...(reply.choices ?? [])
          .filter((choice) => ['project', 'session'].includes(choice.action.kind))
          .map((choice) => ({
            tag: 'div',
            text: { tag: 'plain_text', content: choice.label },
            extra: button('选择', choice.action)
          })),
        ...((reply.choices ?? []).some(
          (choice) => !['project', 'session'].includes(choice.action.kind)
        )
          ? [
              {
                tag: 'action',
                actions: (reply.choices ?? [])
                  .filter((choice) => !['project', 'session'].includes(choice.action.kind))
                  .map((choice) => button(choice.label, choice.action))
              }
            ]
          : []),
        ...(reply.note
          ? [{ tag: 'note', elements: [{ tag: 'plain_text', content: reply.note }] }]
          : []),
        ...(reply.navigation === false
          ? []
          : [
              { tag: 'hr' },
              {
                tag: 'action',
                actions: [
                  button('切换项目', { kind: 'projects' }),
                  button('切换会话', { kind: 'sessions' }),
                  button('当前会话', { kind: 'current' }),
                  ...(reply.target
                    ? [button('会话权限', { kind: 'permissions', value: reply.target.threadId })]
                    : [])
                ]
              }
            ])
      ]
    }
  }
}

export class FeishuReceiver {
  private ws?: WSClient
  private connectionTimer?: NodeJS.Timeout
  private generation = 0
  private status: FeishuReceiverStatus = { phase: 'stopped' }
  private codex = new Map<string, CodexSession>()
  private dialogueTurns = new Set<string>()
  private creating = new Map<string, CodexSession>()

  handlesTurn(threadId: string, turnId?: string): boolean {
    return Boolean(turnId && this.dialogueTurns.has(`${threadId}:${turnId}`))
  }

  constructor(
    private snapshot: () => TasksSnapshot,
    private onStatus: (status: FeishuReceiverStatus) => void,
    private authorizeSession?: (
      grant: ExecutionThread,
      settings: FeishuSettings,
      active: () => boolean
    ) => Promise<void>,
    private registerSession?: (task: TaskRecord) => Promise<void>
  ) {}

  getStatus(): FeishuReceiverStatus {
    const connection = this.ws?.getConnectionStatus?.()
    if (connection?.state === 'idle' || connection?.state === 'failed')
      return {
        ...this.status,
        phase: 'failed',
        issue:
          '飞书接收连接已断开，当前无法接收新消息。请等待重连；若持续失败，请重新启用消息接收。'
      }
    if (connection?.state === 'connecting' || connection?.state === 'reconnecting')
      return { ...this.status, phase: 'starting', issue: undefined }
    return { ...this.status }
  }

  stop(): void {
    this.generation += 1
    clearInterval(this.connectionTimer)
    this.connectionTimer = undefined
    for (const session of this.codex.values()) session.stop()
    this.codex.clear()
    for (const session of this.creating.values()) session.stop()
    this.creating.clear()
    this.ws?.close({ force: true })
    this.ws = undefined
    this.status = { phase: 'stopped' }
    this.onStatus(this.getStatus())
  }

  async configure(settings: FeishuSettings): Promise<void> {
    this.stop()
    if (!settings.receiveEnabled) return
    const generation = this.generation
    const active = (): boolean => generation === this.generation
    const update = (patch: Partial<FeishuReceiverStatus>): void => {
      if (!active()) return
      this.status = { ...this.status, issue: undefined, ...patch }
      this.onStatus(this.getStatus())
    }
    update({ phase: 'starting' })
    const configurations = new Map<string, CodexSessionConfiguration>()
    const onConfiguration = (threadId: string, configuration: CodexSessionConfiguration): void => {
      if (!active()) return
      configurations.set(threadId, configuration)
      if (configurations.size > 1000) configurations.delete(configurations.keys().next().value!)
    }
    const cardFor = (reply: RouteReply): ReturnType<typeof selectionCard> =>
      selectionCard({
        ...reply,
        sessionInfo:
          reply.sessionInfo ??
          (reply.target ? configurationText(configurations.get(reply.target.threadId)) : undefined)
      })
    const client = new Client({ appId: settings.appId, appSecret: settings.appSecret, logger })
    const router = new FeishuRouter(
      this.snapshot,
      settings.executionEnabled ? settings.executionThreads : [],
      settings.executionEnabled && Boolean(this.authorizeSession),
      settings.executionEnabled && Boolean(this.registerSession)
    )
    const grants = new Map(
      (settings.executionEnabled ? settings.executionThreads : []).map((item) => [
        item.threadId,
        item.permission
      ])
    )
    const pendingPermissions = new Set<string>()
    const sessionFor = (threadId: string): CodexSession => {
      if (pendingPermissions.has(threadId)) throw new Error('会话权限正在保存，请稍后再发送需求。')
      const permission = grants.get(threadId)
      if (!permission) throw new Error('此会话尚未授权执行，请点击“当前会话”，在卡片中选择权限。')
      let session = this.codex.get(threadId)
      if (!session) {
        session = new CodexSession(
          settings.codexExecutable,
          (issue) => update({ phase: 'failed', issue, target: threadId }),
          {
            permission,
            onRuntime: (codexRuntime) => update({ codexRuntime }),
            onConfiguration,
            onTurn: (turnId) => {
              this.dialogueTurns.add(`${threadId}:${turnId}`)
              if (this.dialogueTurns.size > 1000)
                this.dialogueTurns.delete(this.dialogueTurns.values().next().value!)
            }
          }
        )
        this.codex.set(threadId, session)
      }
      return session
    }
    const menus = new Map<
      string,
      {
        scope: string
        actions: Map<string, RouteAction>
        target?: RouteReply['target']
        promptId?: string
        questionId?: string
        updatedAt: number
      }
    >()
    const callbacks = new Map<string, object>()
    const remember = (
      messageId: string,
      scope: string,
      actions: Map<string, RouteAction>,
      reply: RouteReply
    ): void => {
      menus.set(messageId, {
        scope,
        actions,
        target: reply.target,
        promptId: reply.promptId,
        questionId: reply.questionId,
        updatedAt: Date.now()
      })
      if (menus.size > 1000) menus.delete(menus.keys().next().value!)
      router.bind(scope, messageId, reply.target?.threadId)
    }
    const seen = new Set<string>()
    let queue = Promise.resolve()
    const startedAt = Date.now()
    const sendReply = async (
      scope: string,
      parentId: string,
      reply: RouteReply,
      messageIds: string[] = []
    ): Promise<void> => {
      const text = Array.from(reply.cardText ?? reply.text)
      // 分段发送完整回答，避免飞书单条消息长度限制；不发送推理或工具原始输出。
      for (let offset = 0; offset < Math.max(1, text.length); offset += 3000) {
        if (!active()) throw new Error('接收连接已关闭。')
        const last = offset + 3000 >= text.length
        const part = {
          ...reply,
          cardText: text.slice(offset, offset + 3000).join(''),
          choices: last ? reply.choices : undefined,
          note: last ? reply.note : undefined,
          navigation: last ? reply.navigation : false
        }
        const menu = cardFor(part)
        const index = offset / 3000
        const messageId = messageIds[index]
        // 同一卡片更新限频；连接、处理、回答和结束均复用原消息。
        if (messageId)
          await delay(Math.max(0, 250 - (Date.now() - (menus.get(messageId)?.updatedAt ?? 0))))
        if (!active()) throw new Error('接收连接已关闭。')
        const result = await client.request<{ code: number; data?: { message_id?: string } }>({
          url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId ?? parentId)}${messageId ? '' : '/reply'}`,
          method: messageId ? 'PATCH' : 'POST',
          timeout: 10000,
          data: {
            ...(messageId ? {} : { msg_type: 'interactive' }),
            content: JSON.stringify(menu.card)
          }
        })
        if (!active()) throw new Error('接收连接已关闭。')
        const deliveredId = messageId ?? result.data?.message_id
        if (result.code !== 0 || !deliveredId) throw new Error('飞书未确认回执送达。')
        messageIds[index] = deliveredId
        remember(deliveredId, scope, menu.actions, part)
        update({
          phase: 'replied',
          repliedAt: new Date().toISOString(),
          target: reply.target?.threadId
        })
      }
    }
    const createSession = async (
      scope: string,
      cwd: string,
      parentId: string,
      messageIds: string[] = []
    ): Promise<void> => {
      if (!active() || !settings.executionEnabled || !this.registerSession)
        throw new Error('请先在电脑端开启 Codex 执行。')
      const snapshot = this.snapshot()
      if (!snapshot.monitoring || !snapshot.tasks.some((task) => task.cwd === cwd))
        throw new Error('项目已不可见，请重新选择项目。')
      if (this.creating.has(scope)) throw new Error('正在创建会话，请等待结果。')
      let created: TaskRecord | undefined
      const session = new CodexSession(
        settings.codexExecutable,
        (issue) => update({ phase: 'failed', issue, target: created?.threadId }),
        {
          onRuntime: (codexRuntime) => update({ codexRuntime }),
          onConfiguration,
          onTurn: (turnId) => {
            if (!created) return
            this.dialogueTurns.add(`${created.threadId}:${turnId}`)
            if (this.dialogueTurns.size > 1000)
              this.dialogueTurns.delete(this.dialogueTurns.values().next().value!)
          }
        }
      )
      this.creating.set(scope, session)
      let delivering = true
      try {
        await sendReply(
          scope,
          parentId,
          { text: `项目：${cwd}\n正在创建会话…`, title: 'Codex 新增会话', navigation: false },
          messageIds
        )
        if (!active()) return
        delivering = false
        created = await session.create(cwd)
        if (!active()) return
        await this.registerSession(created)
        if (!active()) return
        this.codex.set(created.threadId, session)
        const reply = router.act(scope, { kind: 'session', value: created.threadId })
        delivering = true
        await sendReply(
          scope,
          parentId,
          {
            ...reply,
            title: 'Codex 新会话',
            note: '已创建并选中。请选择权限，再发送第一条文字需求。首条需求前请保持软件连接；重启后空会话需重新新增。'
          },
          messageIds
        )
      } catch (error) {
        if (!active()) return
        const issue = delivering
          ? '创建会话的回执未确认送达，请先查看会话列表，勿重复创建。'
          : error instanceof Error
            ? error.message
            : '创建会话未完成，请在电脑端核对。'
        update({ phase: 'failed', issue })
        await sendReply(
          scope,
          parentId,
          {
            text: `${issue}${created ? `\n已创建会话 ID：${created.threadId}` : ''}`,
            title: 'Codex 新增会话',
            target: created
          },
          messageIds
        ).catch(() => update({ phase: 'failed', issue }))
      } finally {
        if (!created || this.codex.get(created.threadId) !== session) session.stop()
        if (this.creating.get(scope) === session) this.creating.delete(scope)
      }
    }
    try {
      const identity = await client.request<{ code: number; bot?: { open_id?: string } }>({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
        timeout: 10000
      })
      if (!active()) return
      const botId = identity.bot?.open_id
      if (identity.code !== 0 || !botId) throw new Error('bot identity unavailable')
      const ws = new WSClient({
        appId: settings.appId,
        appSecret: settings.appSecret,
        logger,
        handshakeTimeoutMs: 10000,
        onReady: () => update({ phase: 'listening' }),
        onReconnecting: () => update({ phase: 'starting' }),
        onReconnected: () => update({ phase: 'listening' }),
        onError: () =>
          update({
            phase: 'failed',
            issue:
              '飞书连接失败，请检查应用凭据、机器人能力、长连接配置及网络。 / Could not connect to Feishu.'
          })
      })
      this.ws = ws
      const startOptions = {
        eventDispatcher: new EventDispatcher({ logger }).register({
          'card.action.trigger': (event: CardActionEvent) => {
            const chatId = event.context?.open_chat_id
            const userId = event.operator?.open_id
            if (
              !active() ||
              chatId !== settings.allowedChatId ||
              userId !== settings.allowedUserId
            ) {
              return { toast: { type: 'error', content: '此操作仅限已配置的群和用户。' } }
            }
            const scope = `${chatId}:${userId}`
            const callbackKey = event.token ? `${scope}:${event.token}` : undefined
            if (callbackKey && callbacks.has(callbackKey)) return callbacks.get(callbackKey)
            const messageId = event.context?.open_message_id
            const menu = messageId ? menus.get(messageId) : undefined
            const actionId = event.action?.value?.actionId
            const action =
              menu?.scope === scope && typeof actionId === 'string'
                ? menu.actions.get(actionId)
                : undefined
            if (!messageId || !action) {
              return {
                toast: { type: 'warning', content: '该菜单已过期，请重新 @机器人发送“项目列表”。' }
              }
            }
            let reply: RouteReply
            try {
              if (action.kind === 'new-session') {
                if (this.creating.has(scope)) throw new Error('正在创建会话，请等待结果。')
                const request = router.act(scope, action)
                if (!request.createCwd) throw new Error(request.text)
                menu!.actions.delete(actionId as string)
                void createSession(scope, request.createCwd, messageId, [messageId]).catch(() =>
                  update({ phase: 'failed', issue: '创建会话未完成，请重新查看项目列表。' })
                )
                return { toast: { type: 'info', content: '正在创建会话…' } }
              }
              if (action.kind === 'permission') {
                const target = menu?.target
                if (!settings.executionEnabled || !this.authorizeSession || !target)
                  throw new Error('请先在电脑端开启 Codex 执行。')
                const canSave = (): boolean => {
                  const snapshot = this.snapshot()
                  const current = snapshot.tasks.find(
                    (task) => task.threadId === target.threadId && task.cwd === target.cwd
                  )
                  return (
                    active() &&
                    snapshot.monitoring &&
                    Boolean(
                      current && ['idle', 'completed', 'interrupted'].includes(current.status)
                    ) &&
                    !this.codex.get(target.threadId)?.running
                  )
                }
                if (!canSave())
                  throw new Error('会话正在运行、状态未知或已不可见，请在本轮结束后重新选择权限。')
                if (pendingPermissions.has(target.threadId))
                  throw new Error('权限正在保存，请稍候。')
                pendingPermissions.add(target.threadId)
                const grant = { threadId: target.threadId, permission: action.value }
                // 文件保存和消息更新放在回调外，及时确认点击，避免飞书重试。
                void (async () => {
                  let saved = false
                  try {
                    await this.authorizeSession!(grant, settings, canSave)
                    saved = true
                    if (!active()) return
                    this.codex.get(target.threadId)?.setPermission(grant.permission)
                    grants.set(target.threadId, grant.permission)
                    router.setExecutionThreads(
                      [...grants].map(([threadId, permission]) => ({ threadId, permission }))
                    )
                    const next = router.act(scope, { kind: 'permissions', value: target.threadId })
                    await sendReply(
                      scope,
                      messageId,
                      { ...next, note: '权限已保存。下一条需求将使用此权限。' },
                      [messageId]
                    )
                  } catch (error) {
                    if (!active()) return
                    const issue = saved
                      ? '权限已保存，但卡片更新未确认送达。'
                      : error instanceof Error
                        ? error.message
                        : '权限保存未完成。'
                    update({ phase: 'failed', issue })
                    await sendReply(
                      scope,
                      messageId,
                      {
                        ...router.act(scope, { kind: 'permissions', value: target.threadId }),
                        note: `请核对当前权限：${issue}`
                      },
                      [messageId]
                    ).catch(() =>
                      update({
                        phase: 'failed',
                        issue: '会话权限回执未送达，请点击“当前会话”核对结果。'
                      })
                    )
                  } finally {
                    pendingPermissions.delete(target.threadId)
                  }
                })()
                const response = { toast: { type: 'info', content: '正在保存会话权限…' } }
                if (callbackKey) {
                  callbacks.set(callbackKey, response)
                  if (callbacks.size > 128) callbacks.delete(callbacks.keys().next().value!)
                }
                return response
              }
              if (
                action.kind === 'answer' ||
                action.kind === 'approve' ||
                action.kind === 'interrupt'
              ) {
                const codex = menu?.target ? this.codex.get(menu.target.threadId) : undefined
                if (!codex || !menu?.target || !grants.has(menu.target.threadId))
                  throw new Error('该操作已过期或此会话未启用执行。')
                const text =
                  action.kind === 'answer'
                    ? codex.answer(action.value, action.requestId, action.questionId)
                    : action.kind === 'approve'
                      ? codex.approve(action.requestId, action.value)
                      : '已请求停止本轮。'
                if (action.kind === 'interrupt') {
                  void codex.interrupt(action.requestId).catch(() =>
                    update({
                      phase: 'failed',
                      issue: '停止按钮已过期或未能确认停止结果，请查看最新轮次。'
                    })
                  )
                  return { toast: { type: 'info', content: text } }
                }
                reply = { text, target: menu.target, title: 'Codex 对话', navigation: false }
              } else reply = router.act(scope, action)
            } catch (error) {
              return {
                toast: {
                  type: 'warning',
                  content: error instanceof Error ? error.message : '操作未完成。'
                }
              }
            }
            const next = cardFor(reply)
            remember(messageId, scope, next.actions, reply)
            update({
              phase: 'listening',
              receivedAt: new Date().toISOString(),
              target: reply.target?.threadId
            })
            const response = { card: { type: 'raw', data: next.card } }
            if (callbackKey) {
              callbacks.set(callbackKey, response)
              if (callbacks.size > 128) callbacks.delete(callbacks.keys().next().value!)
            }
            // 回调直接返回更新后的卡片，不等待网络请求，避免超过飞书响应时限。
            return response
          },
          'im.message.receive_v1': async (event) => {
            const { sender, message } = event
            if (
              !active() ||
              sender.sender_type !== 'user' ||
              sender.sender_id?.open_id !== settings.allowedUserId ||
              message.chat_id !== settings.allowedChatId ||
              message.chat_type !== 'group' ||
              !message.mentions?.some((mention) => mention.id?.open_id === botId)
            )
              return
            // 忽略开启前的积压消息；重连期间同一消息只处理一次。
            if (Number(message.create_time) < startedAt || seen.has(message.message_id)) return
            seen.add(message.message_id)
            if (seen.size > 2000) seen.delete(seen.values().next().value!)
            queue = queue
              .then(async () => {
                if (!active()) return
                update({
                  phase: 'received',
                  receivedAt: new Date().toISOString(),
                  target: undefined
                })
                let text: string | undefined
                if (message.message_type === 'text') {
                  try {
                    const parsed = JSON.parse(message.content) as { text?: unknown }
                    if (typeof parsed.text === 'string') text = parsed.text
                  } catch {
                    /* 非法消息仍发送明确回执。 */
                  }
                }
                for (const mention of message.mentions ?? []) {
                  if (text !== undefined) text = text.split(mention.key).join('')
                }
                const scope = `${message.chat_id}:${sender.sender_id?.open_id}`
                const reply = text?.trim()
                  ? router.route(scope, text, message.parent_id)
                  : { text: '已收到。目前只支持文字，请 @机器人并发送“帮助”。' }
                if (!active()) return
                if (reply.createCwd) {
                  await createSession(scope, reply.createCwd, message.message_id)
                  return
                }
                if (!reply.prompt || !reply.target || !settings.executionEnabled) {
                  await sendReply(scope, message.message_id, reply)
                  return
                }
                const target = reply.target
                const turnMessages: string[] = []
                const title = `Codex · ${target.title || target.threadId}`
                let answerText = ''
                let progress = ''
                let choices: RouteReply['choices']
                try {
                  const codex = sessionFor(target.threadId)
                  const quoted = message.parent_id ? menus.get(message.parent_id) : undefined
                  if (quoted?.promptId || codex.awaitingInput) {
                    const answer = codex.answer(reply.prompt, quoted?.promptId, quoted?.questionId)
                    await sendReply(scope, message.message_id, {
                      text: answer,
                      target,
                      title,
                      navigation: false
                    })
                  } else {
                    if (codex.running)
                      throw new Error('Codex 正在处理，请等待本轮结束；需要中断时点击“停止本轮”。')
                    // 先确认飞书回执可送达，再启动真实执行。
                    await sendReply(
                      scope,
                      message.message_id,
                      {
                        text: `已收到，正在连接会话：${target.title || target.threadId}。`,
                        sessionInfo: configurationText(),
                        target,
                        title,
                        navigation: false
                      },
                      turnMessages
                    )
                    await codex.start(target, reply.prompt, async (output) => {
                      const sessionInfo = configurationText(output.configuration, true)
                      if (
                        output.promptId ||
                        output.choices?.some(
                          (choice) =>
                            choice.action.kind === 'answer' || choice.action.kind === 'approve'
                        )
                      ) {
                        await sendReply(scope, message.message_id, {
                          ...output,
                          sessionInfo,
                          target,
                          title,
                          navigation: false
                        })
                        return
                      }
                      if (output.kind === 'answer' || !output.kind) {
                        answerText += `${answerText ? '\n\n' : ''}${output.text}`
                        progress = ''
                      } else if (output.kind === 'progress') {
                        const characters = Array.from(output.text)
                        progress =
                          characters.slice(0, 600).join('') + (characters.length > 600 ? '…' : '')
                      } else if (output.kind === 'status') {
                        choices = output.choices
                      }
                      const completed = output.kind === 'completed'
                      const body = answerText || (completed ? '' : progress) || output.text
                      const note =
                        output.kind === 'answer'
                          ? '正在处理…'
                          : output.kind === 'progress'
                            ? answerText
                              ? progress
                              : '处理中'
                            : output.text
                      await sendReply(
                        scope,
                        message.message_id,
                        {
                          text: body,
                          sessionInfo,
                          note: note === body ? undefined : note,
                          target,
                          title,
                          choices: completed ? undefined : choices,
                          navigation: completed
                        },
                        turnMessages
                      )
                    })
                  }
                } catch (error) {
                  await sendReply(
                    scope,
                    message.message_id,
                    {
                      text:
                        answerText ||
                        (error instanceof Error ? error.message : 'Codex 请求未完成。'),
                      note: answerText && error instanceof Error ? error.message : undefined,
                      target,
                      title,
                      navigation: true
                    },
                    turnMessages
                  )
                }
              })
              .catch(() =>
                update({
                  phase: 'failed',
                  issue:
                    '已接收消息，但回执未确认送达。请检查发送消息权限及网络后重新发送。 / Reply delivery was not confirmed.'
                })
              )
            // 立即结束事件回调，避免网络发送阻塞飞书事件确认。
          }
        })
      }
      await ws.start(startOptions)
      if (active() && typeof ws.getConnectionStatus === 'function') {
        let restarting = false
        this.connectionTimer = setInterval(() => {
          if (!active()) return
          const status = this.getStatus()
          if (status.phase !== this.status.phase || status.issue !== this.status.issue) {
            this.status = status
            this.onStatus(status)
          }
          // SDK 正常重连由自身处理；仅为空闲断开的连接补一次 start。
          if (ws.getConnectionStatus().state !== 'idle' || restarting) return
          restarting = true
          update({ phase: 'starting' })
          void ws
            .start(startOptions)
            .catch(() =>
              update({ phase: 'failed', issue: '飞书连接重建失败，请重新启用消息接收。' })
            )
            .finally(() => {
              restarting = false
            })
        }, 10000)
      }
    } catch {
      update({
        phase: 'failed',
        issue:
          '飞书连接失败，请检查应用凭据、机器人能力、长连接配置及网络。 / Could not connect to Feishu.'
      })
    }
  }
}
