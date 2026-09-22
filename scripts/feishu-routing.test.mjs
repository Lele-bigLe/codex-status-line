/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node tests are JavaScript. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

function compile(file, replacements = []) {
  let { outputText } = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  })
  for (const [from, to] of replacements) outputText = outputText.replace(from, to)
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
}

const routingUrl = compile('../src/main/services/feishu-routing.ts')
const { FeishuRouter } = await import(routingUrl)
const task = (threadId, cwd) => ({ threadId, cwd, title: '同名会话', status: 'completed' })
const a = task('thread-a', 'D:/project-a')
const b = task('thread-b', 'D:/project-b')
const c = task('thread-c', 'D:/project-a')
function select(router, scope, project = 1, session = 1) {
  router.route(scope, '项目列表')
  router.route(scope, `选择项目 ${project}`)
  router.route(scope, '会话列表')
  return router.route(scope, `选择会话 ${session}`)
}

test('project and session selection keeps IDs stable across reordered snapshots', () => {
  const snapshot = { monitoring: true, tasks: [a, b, c] }
  const router = new FeishuRouter(() => snapshot)
  router.route('user', '项目列表')
  router.route('user', '选择项目 1')
  router.route('user', '会话列表')
  snapshot.tasks = [c, b, a]
  assert.equal(router.route('user', '选择会话 1').target.threadId, a.threadId)
  assert.equal(router.route('user', '继续').target.threadId, a.threadId)
  assert.equal(router.route('user', '选择会话 99').target, undefined)
})

test('commands in replies can select a project and session without a prior message binding', () => {
  const router = new FeishuRouter(() => ({ monitoring: true, tasks: [a, b] }))
  router.route('group:user', '项目列表')
  const project = router.route('group:user', '选择项目 2', 'project-menu')
  assert.match(project.text, /已选择项目：D:\/project-b/)
  assert.match(
    router.route('group:user', '会话列表', 'project-selection').text,
    /thread-b|同名会话/
  )
  assert.equal(router.route('group:user', '选择会话 1', 'session-menu').target.threadId, b.threadId)
  assert.equal(router.route('group:user', '当前会话', 'project-menu').target.threadId, b.threadId)
  assert.equal(router.route('group:user', '继续', 'project-menu').target, undefined)
  assert.equal(router.route('group:other', '选择项目 2', 'project-menu').target, undefined)
  assert.match(router.route('group:user', '项目列表', 'project-menu').text, /项目列表/)
})

test('reply binding overrides current selection without leaking across users or groups', () => {
  const router = new FeishuRouter(() => ({ monitoring: true, tasks: [a, b] }))
  const reply = select(router, 'group:user')
  router.bind('group:user', 'receipt-a', reply.target.threadId)
  select(router, 'group:user', 2)
  assert.equal(router.route('group:user', '继续', 'receipt-a').target.threadId, a.threadId)
  assert.equal(router.route('group:user', '继续').target.threadId, b.threadId)
  assert.equal(router.route('group:other', '继续', 'receipt-a').target, undefined)
  assert.equal(router.route('other:user', '继续', 'receipt-a').target, undefined)
  assert.equal(router.route('group:user', '继续', 'unknown-receipt').target, undefined)
})

test('removed sessions, paused monitoring and restart never fall back to another session', () => {
  const snapshot = { monitoring: true, tasks: [a, b] }
  const router = new FeishuRouter(() => snapshot)
  select(router, 'user')
  router.bind('user', 'receipt-a', a.threadId)
  snapshot.tasks = [b]
  assert.equal(router.route('user', '继续', 'receipt-a').target, undefined)
  assert.equal(router.route('user', '继续').target, undefined)
  snapshot.tasks = [a, b]
  snapshot.monitoring = false
  assert.equal(router.route('user', '继续', 'receipt-a').target, undefined)
  snapshot.monitoring = true
  const restarted = new FeishuRouter(() => snapshot)
  assert.equal(restarted.route('user', '继续', 'receipt-a').target, undefined)
  assert.match(router.route('user', '新建会话').text, /尚未创建/)
})

const fakeSdk = `
export const state = { sent: [], clients: [], failReply: false };
export class Client {
  async request(request) {
    if (request.method === 'GET') return { code: 0, bot: { open_id: 'bot' } };
    state.sent.push(request);
    if (state.failReply) throw new Error('sensitive credential must not escape');
    return { code: 0, data: { message_id: 'receipt-' + state.sent.length } };
  }
}
export class EventDispatcher { register(handlers) { this.handlers = handlers; return this; } }
export class WSClient {
  constructor(options) { this.options = options; state.clients.push(this); }
  async start({ eventDispatcher }) { this.dispatcher = eventDispatcher; this.options.onReady(); }
  close() { this.closed = true; }
}
`
const sdkUrl = `data:text/javascript;base64,${Buffer.from(fakeSdk).toString('base64')}`
const { state } = await import(sdkUrl)
const { FeishuReceiver } = await import(
  compile('../src/main/services/feishu-receiver.ts', [
    ["'@larksuiteoapi/node-sdk'", JSON.stringify(sdkUrl)],
    ["'./codex-session'", JSON.stringify(compile('../src/main/services/codex-session.ts'))],
    ["'./feishu-routing'", JSON.stringify(routingUrl)]
  ])
)

test('receiver filters events, deduplicates, returns routing receipts and stops stale connections', async () => {
  const receiver = new FeishuReceiver(
    () => ({ monitoring: true, tasks: [a, b] }),
    () => {}
  )
  const settings = {
    receiveEnabled: true,
    appId: 'test',
    appSecret: 'test',
    allowedChatId: 'chat',
    allowedUserId: 'user'
  }
  await receiver.configure(settings)
  assert.equal(receiver.getStatus().phase, 'listening')
  const connection = state.clients.at(-1)
  let id = 0
  const event = (text, changes = {}) => ({
    sender: { sender_type: 'user', sender_id: { open_id: 'user' } },
    message: {
      message_id: String(++id),
      chat_id: 'chat',
      chat_type: 'group',
      message_type: 'text',
      create_time: String(Date.now() + 1000),
      content: JSON.stringify({ text: '@bot ' + text }),
      mentions: [{ key: '@bot', id: { open_id: 'bot' } }],
      ...changes
    }
  })
  const deliver = async (value) => {
    await connection.dispatcher.handlers['im.message.receive_v1'](value)
    await new Promise((resolve) => setImmediate(resolve))
  }
  await deliver(event('项目列表', { chat_id: 'other' }))
  await deliver({
    ...event('项目列表'),
    sender: { sender_type: 'user', sender_id: { open_id: 'other' } }
  })
  await deliver(event('项目列表', { mentions: [] }))
  await deliver(event('项目列表', { mentions: [{ key: '@bot', id: { open_id: 'another-bot' } }] }))
  await deliver(event('项目列表', { create_time: '1' }))
  assert.equal(state.sent.length, 0)
  const first = event('项目列表')
  await deliver(first)
  await deliver(first)
  assert.equal(state.sent.length, 1)
  await deliver(event('选择项目 1'))
  await deliver(event('会话列表'))
  await deliver(event('选择会话 1'))
  assert.equal(receiver.getStatus().target, a.threadId)
  await deliver(event('继续', { parent_id: 'receipt-4' }))
  assert.equal(state.sent.at(-1).data.msg_type, 'interactive')
  assert.match(JSON.parse(state.sent.at(-1).data.content).elements[0].text.content, /thread-a/)
  assert.equal(receiver.getStatus().phase, 'replied')
  state.failReply = true
  await deliver(event('继续'))
  assert.equal(receiver.getStatus().phase, 'failed')
  assert.doesNotMatch(receiver.getStatus().issue, /sensitive/)
  state.failReply = false
  await deliver(event('继续'))
  assert.equal(receiver.getStatus().phase, 'replied')
  receiver.stop()
  const sent = state.sent.length
  await deliver(event('继续'))
  connection.options.onReady()
  assert.equal(state.sent.length, sent)
  assert.equal(receiver.getStatus().phase, 'stopped')
  assert.equal(connection.closed, true)
})

test('card buttons select stable project/session IDs, update bindings and reject stale or unauthorized actions', async () => {
  state.sent = []
  const snapshot = { monitoring: true, tasks: [a, b, c] }
  const receiver = new FeishuReceiver(
    () => snapshot,
    () => {}
  )
  await receiver.configure({
    receiveEnabled: true,
    appId: 'test',
    appSecret: 'test',
    allowedChatId: 'chat',
    allowedUserId: 'user'
  })
  const handlers = state.clients.at(-1).dispatcher.handlers
  let id = 0
  const send = async (text, parent_id) => {
    await handlers['im.message.receive_v1']({
      sender: { sender_type: 'user', sender_id: { open_id: 'user' } },
      message: {
        message_id: String(++id),
        chat_id: 'chat',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(Date.now() + 1000),
        content: JSON.stringify({ text: '@bot ' + text }),
        mentions: [{ key: '@bot', id: { open_id: 'bot' } }],
        parent_id
      }
    })
    await new Promise((resolve) => setImmediate(resolve))
    return JSON.parse(state.sent.at(-1).data.content)
  }
  const click = (value, overrides = {}) =>
    handlers['card.action.trigger']({
      token: 'click-' + ++id,
      operator: { open_id: 'user' },
      context: { open_chat_id: 'chat', open_message_id: 'receipt-1' },
      action: { value },
      ...overrides
    })
  const projectCard = await send('项目列表')
  const projectButton = projectCard.elements.find((element) => element.extra).extra.value
  assert.equal(click(projectButton, { operator: { open_id: 'other' } }).toast.type, 'error')
  assert.equal(
    click(projectButton, { context: { open_chat_id: 'other', open_message_id: 'receipt-1' } }).toast
      .type,
    'error'
  )
  const sessionCard = click(projectButton).card.data
  assert.match(sessionCard.elements[0].text.content, /D:\/project-a/)
  assert.equal(
    sessionCard.elements.filter((element) => element.extra).length,
    2,
    'project selection immediately shows its sessions'
  )
  assert.equal(
    click(projectButton).toast.type,
    'warning',
    'obsolete buttons cannot select another item'
  )
  const sessionButton = sessionCard.elements.find((element) => element.extra).extra.value
  snapshot.tasks = [c, b, a]
  const selected = click(sessionButton, { token: 'repeatable' })
  assert.match(selected.card.data.elements[0].text.content, /thread-a/)
  assert.deepEqual(
    click(sessionButton, { token: 'repeatable' }),
    selected,
    'callback retries do not apply the selection twice'
  )
  assert.equal(receiver.getStatus().target, a.threadId)
  assert.match(
    (await send('继续')).elements[0].text.content,
    /thread-a/,
    'direct messages continue the selected session'
  )
  assert.match(
    (await send('继续', 'receipt-1')).elements[0].text.content,
    /thread-a/,
    'updated card is bound to the selected session'
  )
  const switchProject = selected.card.data.elements.at(-1).actions[0].value
  click(switchProject)
  assert.match(
    (await send('继续', 'receipt-1')).elements[0].text.content,
    /没有有效的会话绑定/,
    'menu cards do not keep stale session bindings'
  )
  receiver.stop()
  assert.equal(click(switchProject).toast.type, 'error')
})

test('execution bridge keeps commands local, forwards full answers and routes quoted user input to Codex', async () => {
  state.sent = []
  const sessionUrl = `data:text/javascript;base64,${Buffer.from(
    `
    export const state = { starts: [], answers: [] };
    export class CodexSession {
      running = false; awaitingInput = false;
      stop() { this.running = false; }
      async start(task, text, emit) {
        this.running = true; state.starts.push({ task, text });
        await emit({ text: '答'.repeat(6500) });
        this.awaitingInput = true;
        await emit({ text: '请选择测试代号', promptId: 'question-key', questionId: 'q1' });
      }
      answer(text, key, questionId) {
        state.answers.push({ text, key, questionId }); this.awaitingInput = false;
        return '已提交你的回答。';
      }
    }
  `
  ).toString('base64')}`
  const session = await import(sessionUrl)
  const { FeishuReceiver: Receiver } = await import(
    compile('../src/main/services/feishu-receiver.ts', [
      ["'@larksuiteoapi/node-sdk'", JSON.stringify(sdkUrl)],
      ["'./codex-session'", JSON.stringify(sessionUrl)],
      ["'./feishu-routing'", JSON.stringify(routingUrl)]
    ])
  )
  const receiver = new Receiver(
    () => ({ monitoring: true, tasks: [a, b] }),
    () => {}
  )
  await receiver.configure({
    receiveEnabled: true,
    appId: 'test',
    appSecret: 'test',
    allowedChatId: 'chat',
    allowedUserId: 'user',
    executionEnabled: true,
    executionThreadId: a.threadId
  })
  const handler = state.clients.at(-1).dispatcher.handlers['im.message.receive_v1']
  let id = 0
  const send = async (text, parent_id) => {
    await handler({
      sender: { sender_type: 'user', sender_id: { open_id: 'user' } },
      message: {
        message_id: 'message-' + ++id,
        chat_id: 'chat',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(Date.now() + 1000),
        content: JSON.stringify({ text }),
        mentions: [{ key: '@bot', id: { open_id: 'bot' } }],
        parent_id
      }
    })
    await new Promise((resolve) => setImmediate(resolve))
  }
  for (const text of ['项目列表', '选择项目 1', '选择会话 1', '当前会话']) await send(text)
  assert.equal(
    session.state.starts.length,
    0,
    'selecting or inspecting a session never executes a prompt'
  )
  await send('请开始对话')
  assert.equal(session.state.starts.length, 1)
  assert.equal(session.state.starts[0].text, '请开始对话')
  const replyText = state.sent.map(
    (request) => JSON.parse(request.data.content).elements[0].text.content
  )
  assert.equal(replyText.filter((text) => /^答+$/.test(text)).join(''), '答'.repeat(6500))
  const questionMessageId = 'receipt-' + state.sent.length
  await send('蓝桥', questionMessageId)
  assert.deepEqual(session.state.answers, [{ text: '蓝桥', key: 'question-key', questionId: 'q1' }])
  assert.equal(session.state.starts.length, 1, 'answering a question does not start another turn')
  await send('选择项目 2')
  await send('选择会话 1')
  await send('不要执行其他会话')
  assert.equal(session.state.starts.length, 1)
  assert.match(
    JSON.parse(state.sent.at(-1).data.content).elements[0].text.content,
    /仅允许配置的测试会话/
  )
  receiver.stop()
})
