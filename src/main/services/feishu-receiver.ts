import { Client, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  FeishuSettings,
  FeishuReceiverStatus,
  ExecutionThread,
  CodexSessionConfiguration
} from '../../shared/feishu'
import type { TasksSnapshot, TaskRecord } from '../../shared/tasks'
import { FeishuRouter, type ProjectSessionSelection, type RouteAction, type RouteReply } from './feishu-routing'
import { CodexSession } from './codex-session'

// SDK 的异常可能包含带凭据的请求对象，统一使用脱敏状态反馈。
const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} }

interface CardActionEvent {
  token?: string
  operator?: { open_id?: string }
  context?: { open_chat_id?: string; open_message_id?: string }
  action?: { value?: { actionId?: unknown }; option?: unknown; tag?: string }
}

function configurationText(configuration?: CodexSessionConfiguration, current = false): string {
  if (!configuration) return '模型及思考程度待确认'
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
  return `${current ? '本轮' : '最近确认'}：${configuration.model || '未返回'} · ${label}`
}

const ANSWER_PAGE_SIZE = 3000

function answerView(reply: RouteReply, page = -1): { reply: RouteReply; page: number } {
  const content = reply.cardText ?? reply.text
  const characters = Array.from(content)
  if (characters.length <= 240 && content.split('\n').length <= 8) return { reply, page: -1 }
  const pages = Math.ceil(characters.length / ANSWER_PAGE_SIZE)
  // 运行中的卡片持续更新；结束后再提供展开，避免交互回调覆盖较新的输出。
  const expanded = reply.navigation === true && page >= 0
  const current = expanded ? Math.min(page, pages - 1) : -1
  const choices: NonNullable<RouteReply['choices']> = []
  if (reply.navigation === true) {
    if (expanded) {
      if (current > 0) choices.push({ label: '上一页', action: { kind: 'answer-view', page: current - 1 } })
      if (current + 1 < pages) choices.push({ label: '下一页', action: { kind: 'answer-view', page: current + 1 } })
      choices.push({ label: '收起', action: { kind: 'answer-view', page: -1 } })
    } else choices.push({ label: '展开全文', action: { kind: 'answer-view', page: 0 } })
  }
  return {
    page: current,
    reply: {
      ...reply,
      cardText: expanded
        ? characters.slice(current * ANSWER_PAGE_SIZE, (current + 1) * ANSWER_PAGE_SIZE).join('')
        : `${characters.slice(0, 240).join('').split('\n').slice(0, 8).join('\n').trimEnd()}\n…`,
      choices: [...(reply.choices ?? []), ...choices],
      note: expanded && pages > 1 ? [reply.note, `第 ${current + 1}/${pages} 页`].filter(Boolean).join(' · ') : reply.note
    }
  }
}

function selectionCard(reply: RouteReply): {
  card: object
  actions: Map<string, RouteAction>
} {
  const actions = new Map<string, RouteAction>()
  const button = (label: string, action: RouteAction, primary = false): object => {
    const actionId = randomUUID()
    actions.set(actionId, action)
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      value: { actionId },
      type: primary ? 'primary' : 'default'
    }
  }
  const target = reply.target
  const navigation: object[] = []
  if (reply.navigation !== false) {
    if (target) {
      if (reply.view === 'turn' || reply.view === 'details')
        navigation.push(button('继续此会话', { kind: 'session', value: target.threadId }, true))
      else if (reply.view !== 'details')
        navigation.push(button('详情', { kind: 'details', value: target.threadId }))
      navigation.push(button('切换', { kind: 'projects' }))
    } else {
      navigation.push(button('选择会话', { kind: 'projects' }))
    }
  }
  const selects = (reply.selects ?? []).filter((select) => select.options.length).map((select) => {
    let initial: string | undefined
    const options = select.options.map((option) => {
      const id = randomUUID()
      actions.set(id, { kind: select.kind, value: option.value })
      if (option.value === select.selected) initial = id
      return { text: { tag: 'plain_text', content: option.label }, value: id }
    })
    return {
      tag: 'action',
      actions: [{
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: select.kind === 'project' ? '选择项目' : '选择会话' },
        width: 'fill',
        options,
        ...(initial ? { initial_option: initial } : {})
      }]
    }
  })
  const name = target?.title || (target ? `会话 ${target.threadId.slice(-8)}` : '')
  const targetName = Array.from(name).length > 32 ? `${Array.from(name).slice(0, 32).join('')}…` : name
  const title = reply.view === 'switcher' ? '切换会话' : target
    ? `${basename(target.cwd) || target.cwd} · ${targetName}${reply.title && reply.title !== name ? ` · ${reply.title}` : ''}`
    : reply.title || 'Codex 会话选择'
  const sessionInfo = reply.view === 'switcher' ? '' : [reply.sessionInfo, target && reply.view !== 'details' ? target.threadId.slice(-8) : undefined]
    .filter(Boolean).join(' · ')
  const content = reply.cardText ?? reply.text
  return {
    actions,
    card: {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template: 'blue'
      },
      elements: [
        ...(content ? [{ tag: 'div', text: { tag: 'plain_text', content } }] : []),
        ...(sessionInfo
          ? [{ tag: 'note', elements: [{ tag: 'plain_text', content: sessionInfo }] }]
          : []),
        ...selects,
        ...(reply.choices?.length
          ? [
              {
                tag: 'action',
                actions: reply.choices.map((choice) => button(choice.label, choice.action))
              }
            ]
          : []),
        ...(reply.note && reply.note !== content
          ? [{ tag: 'note', elements: [{ tag: 'plain_text', content: reply.note }] }]
          : []),
        ...(!navigation.length
          ? []
          : [
              { tag: 'hr' },
              {
                tag: 'action',
                actions: navigation
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
    private registerSession?: (task: TaskRecord) => Promise<void>,
    private sessionMemory?: {
      load: () => ProjectSessionSelection[]
      save: (selection: ProjectSessionSelection, settings: FeishuSettings, active: () => boolean) => Promise<void>
    }
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
    const groupChat = settings.receiveMode !== 'p2p'
    const mention = groupChat ? ' @机器人' : ''
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
      settings.executionEnabled && Boolean(this.registerSession),
      groupChat,
      {
        selections: this.sessionMemory?.load() ?? [],
        remember: (selection) => {
          void this.sessionMemory?.save(selection, settings, active).catch(() =>
            update({ issue: '会话已切换，但最近会话保存失败，重启后可能需要重新选择。' })
          )
        }
      }
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
      if (!permission) throw new Error('此会话尚未授权执行，请在切换卡片的“详情”中选择权限。')
      let session = this.codex.get(threadId)
      if (!session) {
        session = new CodexSession(
          settings.codexExecutable,
          (issue) => update({ phase: 'failed', issue, target: threadId }),
          {
            permission,
            mentionRequired: groupChat,
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
        view?: RouteReply['view']
        reply?: RouteReply
        page?: number
        updatedAt: number
      }
    >()
    const callbacks = new Map<string, object>()
    const remember = (
      messageId: string,
      scope: string,
      actions: Map<string, RouteAction>,
      reply: RouteReply,
      page?: number
    ): void => {
      menus.set(messageId, {
        scope,
        actions,
        target: reply.target,
        promptId: reply.promptId,
        questionId: reply.questionId,
        view: reply.view,
        reply: reply.view === 'turn' ? reply : undefined,
        page,
        updatedAt: Date.now()
      })
      if (menus.size > 1000) menus.delete(menus.keys().next().value!)
      router.bind(scope, messageId, reply.target?.threadId)
    }
    const seen = new Set<string>()
    const queues = new Map<string, Promise<void>>()
    const startedAt = Date.now()
    const sendReply = async (
      scope: string,
      parentId: string,
      reply: RouteReply,
      messageIds: string[] = []
    ): Promise<void> => {
      const turn = reply.view === 'turn'
      const text = turn ? [] : Array.from(reply.cardText ?? reply.text)
      // 回答始终复用一张卡片；审批和问题仍分段完整展示，不参与预览。
      for (let offset = 0; offset < Math.max(1, text.length); offset += ANSWER_PAGE_SIZE) {
        if (!active()) throw new Error('接收连接已关闭。')
        const index = offset / ANSWER_PAGE_SIZE
        const messageId = messageIds[index]
        const presentation = turn ? answerView(reply, messageId ? menus.get(messageId)?.page : undefined) : undefined
        const last = offset + ANSWER_PAGE_SIZE >= text.length
        const part = presentation?.reply ?? {
          ...reply,
          cardText: text.slice(offset, offset + ANSWER_PAGE_SIZE).join(''),
          choices: last ? reply.choices : undefined,
          note: last ? reply.note : undefined,
          navigation: last ? reply.navigation : false
        }
        const menu = cardFor(part)
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
        remember(deliveredId, scope, menu.actions, turn ? reply : part, presentation?.page)
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
      messageIds: string[] = [],
      selectionVersion = router.selectionVersion(scope)
    ): Promise<void> => {
      if (!active() || !settings.executionEnabled || !this.registerSession)
        throw new Error('请先在电脑端开启 Codex 执行。')
      const snapshot = this.snapshot()
      if (!snapshot.monitoring || !snapshot.tasks.some((task) => task.cwd === cwd))
        throw new Error('项目已不可见，请重新选择项目。')
      const createKey = `${scope}:${cwd}`
      if (this.creating.has(createKey)) throw new Error('该项目正在创建会话，请等待结果。')
      let created: TaskRecord | undefined
      const session = new CodexSession(
        settings.codexExecutable,
        (issue) => update({ phase: 'failed', issue, target: created?.threadId }),
        {
          mentionRequired: groupChat,
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
      this.creating.set(createKey, session)
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
        const selectCreated = router.selectionVersion(scope) === selectionVersion
        if (selectCreated) router.act(scope, { kind: 'session', value: created.threadId })
        const reply = router.act(scope, { kind: 'details', value: created.threadId })
        delivering = true
        await sendReply(
          scope,
          parentId,
          {
            ...reply,
            title: 'Codex 新会话',
            note: `${selectCreated ? '已创建并选中。请选择权限，再发送第一条文字需求。' : '已创建，当前会话保持不变。选择权限后，点击“继续此会话”再发送需求。'}首条需求前请保持软件连接；重启后空会话需重新新增。`
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
        if (this.creating.get(createKey) === session) this.creating.delete(createKey)
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
              !chatId ||
              (groupChat && chatId !== settings.allowedChatId) ||
              userId !== settings.allowedUserId
            ) {
              return { toast: { type: 'error', content: '此操作仅限已配置的用户和会话。' } }
            }
            const scope = `${chatId}:${userId}`
            const callbackKey = event.token ? `${scope}:${event.token}` : undefined
            if (callbackKey && callbacks.has(callbackKey)) return callbacks.get(callbackKey)
            const messageId = event.context?.open_message_id
            const menu = messageId ? menus.get(messageId) : undefined
            const actionId = event.action?.tag === 'select_static' || event.action?.option !== undefined
              ? event.action.option : event.action?.value?.actionId
            const action =
              menu?.scope === scope && typeof actionId === 'string'
                ? menu.actions.get(actionId)
                : undefined
            if (!messageId || !action) {
              return {
                toast: { type: 'warning', content: `该菜单已过期，请重新${mention}发送“项目列表”。` }
              }
            }
            let reply: RouteReply
            try {
              if (action.kind === 'answer-view') {
                if (!menu?.reply || menu.view !== 'turn' || menu.reply.navigation !== true)
                  throw new Error('回答尚未结束或已过期，请查看最新卡片。')
                const presentation = answerView(menu.reply, action.page)
                const next = cardFor(presentation.reply)
                remember(messageId, scope, next.actions, menu.reply, presentation.page)
                const response = { card: { type: 'raw', data: next.card } }
                if (callbackKey) {
                  callbacks.set(callbackKey, response)
                  if (callbacks.size > 128) callbacks.delete(callbacks.keys().next().value!)
                }
                return response
              }
              if (action.kind === 'new-session') {
                const request = router.act(scope, action)
                if (!request.createCwd) throw new Error(request.text)
                if (this.creating.has(`${scope}:${request.createCwd}`))
                  throw new Error('该项目正在创建会话，请等待结果。')
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
                      { ...next, note: '权限已保存，后续发往此会话的需求将使用此权限。' },
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
                        issue: '会话权限回执未送达，请发送“当前会话”，在详情中核对结果。'
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
                      issue: '停止按钮已过期或未能确认停止结果，请查看最新轮次。',
                      target: menu.target?.threadId
                    })
                  )
                  return { toast: { type: 'info', content: text } }
                }
                // 已处理的卡片仍保留请求身份，引用旧卡片不能变成新一轮任务。
                reply = {
                  text,
                  target: menu.target,
                  title: action.kind === 'answer' ? '已回答' : '已处理',
                  navigation: false,
                  view: menu.view,
                  promptId: menu.promptId,
                  questionId: menu.questionId
                }
              } else reply = router.act(scope, action)
            } catch (error) {
              return {
                toast: {
                  type: 'warning',
                  content: error instanceof Error ? error.message : '操作未完成。'
                }
              }
            }
            if (menu?.view === 'turn') {
              if (action.kind === 'session' && !reply.target)
                return { toast: { type: 'warning', content: reply.text } }
              if (action.kind === 'session')
                update({ phase: 'listening', receivedAt: new Date().toISOString(), target: reply.target?.threadId })
              // 回答卡片只负责展示本轮内容，导航另开控制卡片，避免覆盖回答。
              if (action.kind !== 'session')
                void sendReply(scope, messageId, reply).catch(() =>
                  update({ phase: 'failed', issue: '会话操作回执未确认送达，请重新打开会话详情。', target: menu.target?.threadId })
                )
              const response = {
                toast: { type: 'info', content: action.kind === 'session' ? '已切到此会话，下一条消息将发往这里。' : '正在打开…' }
              }
              if (callbackKey) {
                callbacks.set(callbackKey, response)
                if (callbacks.size > 128) callbacks.delete(callbacks.keys().next().value!)
              }
              return response
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
              sender.sender_id?.open_id !== settings.allowedUserId
            )
              return
            if (groupChat) {
              if (
                message.chat_id !== settings.allowedChatId ||
                message.chat_type !== 'group' ||
                !message.mentions?.some((item) => item.id?.open_id === botId)
              ) return
            } else if (message.chat_type !== 'p2p') return
            // 忽略开启前的积压消息；重连期间同一消息只处理一次。
            if (Number(message.create_time) < startedAt || seen.has(message.message_id)) return
            seen.add(message.message_id)
            if (seen.size > 2000) seen.delete(seen.values().next().value!)
            let text: string | undefined
            if (message.message_type === 'text') {
              try {
                const parsed = JSON.parse(message.content) as { text?: unknown }
                if (typeof parsed.text === 'string') text = parsed.text
              } catch {
                /* 非法消息仍发送明确回执。 */
              }
            }
            for (const item of message.mentions ?? []) {
              if (text !== undefined) text = text.split(item.key).join('')
            }
            const scope = `${message.chat_id}:${sender.sender_id?.open_id}`
            // 收到消息时就锁定目标，不让排队期间的会话切换改变投递对象。
            const reply: RouteReply = text?.trim()
              ? router.route(scope, text, message.parent_id)
              : { text: `已收到。目前只支持文字，请${mention}发送“帮助”。` }
            const parentMenu = message.parent_id ? menus.get(message.parent_id) : undefined
            const quoted = parentMenu?.scope === scope ? parentMenu : undefined
            const selectionVersion = router.selectionVersion(scope)
            if (reply.target) router.bind(scope, message.message_id, reply.target.threadId)
            const queueKey = reply.target
              ? `session:${reply.target.threadId}`
              : reply.createCwd ? `create:${scope}:${reply.createCwd}` : `menu:${scope}`
            const pending: Promise<void> = (queues.get(queueKey) ?? Promise.resolve())
              .then(async () => {
                if (!active()) return
                update({
                  phase: 'received',
                  receivedAt: new Date().toISOString(),
                  target: reply.target?.threadId
                })
                if (reply.createCwd) {
                  await createSession(scope, reply.createCwd, message.message_id, [], selectionVersion)
                  return
                }
                if (!reply.prompt || !reply.target || !settings.executionEnabled) {
                  await sendReply(scope, message.message_id, reply)
                  return
                }
                const target = reply.target
                const turnMessages: string[] = []
                const title = target.title || `会话 ${target.threadId.slice(-8)}`
                let answerText = ''
                let progress = ''
                let choices: RouteReply['choices']
                try {
                  const codex = sessionFor(target.threadId)
                  if (quoted?.view === 'approval')
                    throw new Error('审批请使用对应卡片上的允许或拒绝按钮。')
                  if (quoted?.view === 'question' || codex.awaitingInput) {
                    if (quoted?.view === 'question' && !quoted.promptId)
                      throw new Error('这个问题已结束，请查看最新的问题卡片。')
                    if (message.parent_id && quoted?.view !== 'question')
                      throw new Error('会话正在等待回答，请回复对应的问题卡片。')
                    const answer = codex.answer(reply.prompt, quoted?.promptId, quoted?.questionId)
                    await sendReply(
                      scope,
                      message.parent_id ?? message.message_id,
                      {
                        text: answer,
                        target,
                        title,
                        navigation: false,
                        view: 'question',
                        promptId: quoted?.promptId,
                        questionId: quoted?.questionId
                      },
                      message.parent_id ? [message.parent_id] : []
                    )
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
                        view: 'turn',
                        navigation: false
                      },
                      turnMessages
                    )
                    if (pendingPermissions.has(target.threadId))
                      throw new Error('此会话权限正在保存，请稍后再发送需求。')
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
                          title: output.promptId ? '待回答' : '待审批',
                          view: output.promptId ? 'question' : 'approval',
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
                      const note = output.kind === 'answer' || output.kind === 'progress'
                        ? '正在处理…' : output.text
                      await sendReply(
                        scope,
                        message.message_id,
                        {
                          text: body,
                          sessionInfo,
                          note: note === body ? undefined : note,
                          target,
                          title,
                          view: 'turn',
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
                      view: 'turn',
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
              .finally(() => {
                if (queues.get(queueKey) === pending) queues.delete(queueKey)
              })
            queues.set(queueKey, pending)
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
