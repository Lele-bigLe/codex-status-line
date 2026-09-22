/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node tests are JavaScript. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const url = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const transportUrl = url(`
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
export const state = { writes: [], child: undefined };
export function spawn(executable, args, options) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { child.killed = true; };
  child.send = value => child.stdout.write(JSON.stringify(value)+'\\n');
  child.stdin.on('data', chunk => {
    const message = JSON.parse(chunk.toString()); state.writes.push(message);
    if (message.id === undefined || !message.method) return;
    let result = {};
    if (message.method === 'thread/resume') result = { thread: { id: message.params.threadId, cwd: options.cwd, status: { type:'idle' } } };
    if (message.method === 'turn/start') result = { turn: { id:'turn-'+state.writes.length } };
    child.send({ id:message.id, result });
    if (message.method === 'turn/start') child.send({method:'turn/started',params:{threadId:message.params.threadId,turn:result.turn}});
  });
  state.child = child; return child;
}`)
const { state } = await import(transportUrl)
const { outputText } = ts.transpileModule(
  readFileSync(new URL('../src/main/services/codex-session.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }
)
const { CodexSession } = await import(
  url(outputText.replace("'node:child_process'", JSON.stringify(transportUrl)))
)
const task = { threadId: 'test-thread', cwd: process.cwd(), status: 'completed' }
const flush = () => new Promise((resolve) => setImmediate(resolve))
const request = (id, method, params) =>
  state.child.send({ id, method, params: { threadId: task.threadId, ...params } })
const finish = () =>
  state.child.send({
    method: 'turn/completed',
    params: { threadId: task.threadId, turn: { status: 'completed' } }
  })

test('resumes exact thread read-only, forwards only visible assistant replies, and rejects busy sessions', async () => {
  const output = []
  const session = new CodexSession(process.execPath, () => {})
  await assert.rejects(
    session.start({ ...task, status: 'running' }, 'hello', async () => {}),
    /其他窗口/
  )
  await session.start(task, 'hello', async (item) => {
    output.push(item)
  })
  const resume = state.writes.find((item) => item.method === 'thread/resume')
  assert.equal(resume.params.threadId, task.threadId)
  assert.equal(resume.params.sandbox, 'read-only')
  assert.equal(resume.params.approvalPolicy, 'untrusted')
  await assert.rejects(
    session.start(task, 'second', async () => {}),
    /正在处理/
  )
  const sendItem = (item) =>
    state.child.send({ method: 'item/completed', params: { threadId: task.threadId, item } })
  sendItem({ id: 'reason', type: 'reasoning', text: 'private reasoning' })
  sendItem({ id: 'answer', type: 'agentMessage', text: 'hello user', phase: 'final_answer' })
  sendItem({ id: 'answer', type: 'agentMessage', text: 'hello user', phase: 'final_answer' })
  finish()
  await flush()
  assert.equal(output.filter((item) => item.text.includes('hello user')).length, 1)
  assert.ok(output.every((item) => !item.text.includes('private reasoning')))
  assert.equal(session.running, false)
})

test('multi-question answers preserve request IDs and old options cannot answer later questions', async () => {
  const output = []
  const session = new CodexSession(process.execPath, () => {})
  await session.start(task, 'ask me', async (item) => {
    output.push(item)
  })
  request('question-rpc', 'item/tool/requestUserInput', {
    questions: [
      {
        id: 'q1',
        question: 'Choose one',
        isSecret: false,
        options: [{ label: 'A', description: 'choice A' }]
      },
      { id: 'q2', question: 'Add detail', isSecret: false, options: null }
    ]
  })
  await flush()
  const prompt = output.find((item) => item.promptId)
  session.answer('A', prompt.promptId, 'q1')
  assert.throws(() => session.answer('A', prompt.promptId, 'q1'), /已回答/)
  assert.equal(session.awaitingInput, true)
  session.answer('details', prompt.promptId, 'q2')
  assert.deepEqual(state.writes.find((item) => item.id === 'question-rpc').result, {
    answers: { q1: { answers: ['A'] }, q2: { answers: ['details'] } }
  })
  assert.equal(session.awaitingInput, false)
  assert.throws(() => session.answer('again', prompt.promptId), /过期/)
  session.stop()
  await flush()
})

test('approvals require explicit decisions and stale stop buttons cannot affect another turn', async () => {
  const output = []
  const session = new CodexSession(process.execPath, () => {})
  await session.start(task, 'work', async (item) => {
    output.push(item)
  })
  request('approval-rpc', 'item/commandExecution/requestApproval', {
    command: 'Get-Date',
    cwd: task.cwd
  })
  await flush()
  const approval = output
    .flatMap((item) => item.choices ?? [])
    .find((item) => item.action.kind === 'approve')
  assert.equal(
    state.writes.some((item) => item.id === 'approval-rpc'),
    false
  )
  session.approve(approval.action.requestId, 'decline')
  assert.deepEqual(state.writes.find((item) => item.id === 'approval-rpc').result, {
    decision: 'decline'
  })
  assert.throws(() => session.approve(approval.action.requestId, 'accept'), /过期/)
  const oldStop = output
    .flatMap((item) => item.choices ?? [])
    .find((item) => item.action.kind === 'interrupt').action.requestId
  finish()
  await flush()
  await session.start(task, 'another', async () => {})
  await assert.rejects(session.interrupt(oldStop), /已经结束/)
  session.stop()
})

test('secret questions and unsupported permission requests are never auto-approved', async () => {
  const output = []
  const session = new CodexSession(process.execPath, () => {})
  await session.start(task, 'work', async (item) => {
    output.push(item)
  })
  request('secret-rpc', 'item/tool/requestUserInput', {
    questions: [{ id: 'secret', question: 'secret prompt content', isSecret: true, options: null }]
  })
  await flush()
  assert.ok(output.every((item) => !item.text.includes('secret prompt content')))
  assert.deepEqual(state.writes.find((item) => item.id === 'secret-rpc').result, { answers: {} })
  assert.ok(state.writes.some((item) => item.method === 'turn/interrupt'))
  request('permission-rpc', 'item/permissions/requestApproval', {
    permissions: { network: { enabled: true } }
  })
  assert.deepEqual(state.writes.find((item) => item.id === 'permission-rpc').result, {
    permissions: {},
    scope: 'turn'
  })
  session.stop()
})
