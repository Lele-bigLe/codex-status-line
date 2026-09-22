import { Client, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk'
import { randomUUID } from 'node:crypto'
import type { FeishuSettings, FeishuReceiverStatus } from '../../shared/feishu'
import type { TasksSnapshot } from '../../shared/tasks'
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
        ...(reply.choices ?? []).map((choice) => ({
          tag: 'div',
          text: { tag: 'plain_text', content: choice.label },
          extra: button(
            choice.action.kind === 'answer' ||
              choice.action.kind === 'approve' ||
              choice.action.kind === 'interrupt'
              ? choice.label
              : '选择',
            choice.action
          )
        })),
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            button('切换项目', { kind: 'projects' }),
            button('切换会话', { kind: 'sessions' }),
            button('当前会话', { kind: 'current' })
          ]
        }
      ]
    }
  }
}

export class FeishuReceiver {
  private ws?: WSClient
  private generation = 0
  private status: FeishuReceiverStatus = { phase: 'stopped' }
  private codex?: CodexSession

  constructor(
    private snapshot: () => TasksSnapshot,
    private onStatus: (status: FeishuReceiverStatus) => void
  ) {}

  getStatus(): FeishuReceiverStatus {
    return { ...this.status }
  }

  stop(): void {
    this.generation += 1
    this.codex?.stop()
    this.codex = undefined
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
    const client = new Client({ appId: settings.appId, appSecret: settings.appSecret, logger })
    const router = new FeishuRouter(
      this.snapshot,
      settings.executionEnabled ? settings.executionThreadId : undefined
    )
    const codex = settings.executionEnabled
      ? new CodexSession(settings.codexExecutable, (issue) => update({ phase: 'failed', issue }))
      : undefined
    this.codex = codex
    const menus = new Map<
      string,
      {
        scope: string
        actions: Map<string, RouteAction>
        target?: RouteReply['target']
        promptId?: string
        questionId?: string
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
        questionId: reply.questionId
      })
      if (menus.size > 1000) menus.delete(menus.keys().next().value!)
      router.bind(scope, messageId, reply.target?.threadId)
    }
    const seen = new Set<string>()
    let queue = Promise.resolve()
    const startedAt = Date.now()
    const sendReply = async (scope: string, parentId: string, reply: RouteReply): Promise<void> => {
      const text = Array.from(reply.cardText ?? reply.text)
      // 分段发送完整回答，避免飞书单条消息长度限制；不发送推理或工具原始输出。
      for (let offset = 0; offset < Math.max(1, text.length); offset += 3000) {
        if (!active()) throw new Error('接收连接已关闭。')
        const last = offset + 3000 >= text.length
        const part = {
          ...reply,
          cardText: text.slice(offset, offset + 3000).join(''),
          choices: last ? reply.choices : undefined
        }
        const menu = selectionCard(part)
        const result = await client.request<{ code: number; data?: { message_id?: string } }>({
          url: `/open-apis/im/v1/messages/${encodeURIComponent(parentId)}/reply`,
          method: 'POST',
          timeout: 10000,
          data: { msg_type: 'interactive', content: JSON.stringify(menu.card) }
        })
        if (!active()) throw new Error('接收连接已关闭。')
        if (result.code !== 0 || !result.data?.message_id) throw new Error('飞书未确认回执送达。')
        remember(result.data.message_id, scope, menu.actions, part)
        update({
          phase: 'replied',
          repliedAt: new Date().toISOString(),
          target: reply.target?.threadId
        })
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
      await ws.start({
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
              if (
                action.kind === 'answer' ||
                action.kind === 'approve' ||
                action.kind === 'interrupt'
              ) {
                if (!codex || menu?.target?.threadId !== settings.executionThreadId)
                  throw new Error('该操作已过期或此会话未启用执行。')
                const text =
                  action.kind === 'answer'
                    ? codex.answer(action.value, action.requestId, action.questionId)
                    : action.kind === 'approve'
                      ? codex.approve(action.requestId, action.value)
                      : '已请求停止本轮。'
                if (action.kind === 'interrupt')
                  void codex
                    .interrupt(action.requestId)
                    .catch(() =>
                      update({
                        phase: 'failed',
                        issue: '停止按钮已过期或未能确认停止结果，请查看最新轮次。'
                      })
                    )
                reply = { text, target: menu.target, title: 'Codex 对话' }
              } else reply = router.act(scope, action)
            } catch (error) {
              return {
                toast: {
                  type: 'warning',
                  content: error instanceof Error ? error.message : '操作未完成。'
                }
              }
            }
            const next = selectionCard(reply)
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
                if (!reply.prompt || !reply.target || !codex) {
                  await sendReply(scope, message.message_id, reply)
                  return
                }
                const target = reply.target
                try {
                  if (target.threadId !== settings.executionThreadId)
                    throw new Error('当前仅允许配置的测试会话执行，请切换到该会话。')
                  const quoted = message.parent_id ? menus.get(message.parent_id) : undefined
                  if (quoted?.promptId || codex.awaitingInput) {
                    const answer = codex.answer(reply.prompt, quoted?.promptId, quoted?.questionId)
                    await sendReply(scope, message.message_id, {
                      text: answer,
                      target,
                      title: 'Codex 对话'
                    })
                  } else {
                    if (codex.running)
                      throw new Error('Codex 正在处理，请等待本轮结束；需要中断时点击“停止本轮”。')
                    // 先确认飞书回执可送达，再启动真实执行。
                    await sendReply(scope, message.message_id, {
                      text: '已收到，正在连接所选 Codex 测试会话。',
                      target,
                      title: 'Codex 对话'
                    })
                    await codex.start(target, reply.prompt, (output) =>
                      sendReply(scope, message.message_id, {
                        ...output,
                        target,
                        title: 'Codex 对话'
                      })
                    )
                  }
                } catch (error) {
                  await sendReply(scope, message.message_id, {
                    text: error instanceof Error ? error.message : 'Codex 请求未完成。',
                    target,
                    title: 'Codex 对话'
                  })
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
      })
    } catch {
      update({
        phase: 'failed',
        issue:
          '飞书连接失败，请检查应用凭据、机器人能力、长连接配置及网络。 / Could not connect to Feishu.'
      })
    }
  }
}
