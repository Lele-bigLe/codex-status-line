import assert from 'node:assert/strict'
import { readFileSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

async function load(file) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
}
const { TaskMonitor, sessionMetadata, taskFromEvent, turnRequestSummary } = await load(
  '../src/main/services/tasks.ts'
)
const { taskWindowBounds, taskHoverExpanded, taskNotificationContent } =
  await load('../src/shared/tasks.ts')

test('task hover delays, pinning and expansion stay within the display', () => {
  const folded = { expanded: false, pinned: false },
    open = { expanded: true, pinned: false }
  assert.equal(taskHoverExpanded(true, folded, 179), false)
  assert.equal(taskHoverExpanded(true, folded, 180), true)
  assert.equal(taskHoverExpanded(false, open, 449), true)
  assert.equal(taskHoverExpanded(false, open, 450), false)
  assert.equal(taskHoverExpanded(false, { ...open, pinned: true }, 5000), true)
  const area = { x: -1280, y: 0, width: 1280, height: 720 },
    anchor = { x: -280, y: 688 }
  const compact = taskWindowBounds(anchor, area, false),
    expanded = taskWindowBounds(anchor, area, true)
  assert.deepEqual(compact, { x: -280, y: 688, width: 280, height: 32 })
  assert.deepEqual(expanded, { x: -360, y: 240, width: 360, height: 480 })
  assert.equal(
    taskWindowBounds(anchor, area, true, 2).height,
    360,
    'two sessions use a compact panel'
  )
  assert.equal(taskWindowBounds(anchor, area, true, 0).height, 300, 'empty state has enough space')
  assert.equal(
    taskWindowBounds(anchor, area, true, 100).height,
    480,
    'long lists scroll within the maximum height'
  )
  assert.deepEqual(
    taskWindowBounds(anchor, area, false),
    compact,
    'collapse restores the bar anchor'
  )
  assert.deepEqual(
    taskWindowBounds({ x: 500, y: 500 }, { x: 0, y: 0, width: 300, height: 240 }, true),
    { x: 0, y: 0, width: 300, height: 240 }
  )
})

test('local task lifecycle: partial writes, deduplication, restart and pause', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-status-tasks-'))
  const sessions = path.join(temp, 'sessions')
  const state = path.join(temp, 'tasks.json')
  await fs.mkdir(sessions)
  await fs.writeFile(
    path.join(temp, 'session_index.jsonl'),
    JSON.stringify({
      id: 'session-1',
      thread_name: '测试会话标题',
      updated_at: '2026-09-16T10:00:00Z'
    }) + '\n'
  )
  const file = path.join(sessions, 'session.jsonl')
  const metadata = {
    type: 'session_meta',
    payload: { id: 'session-1', cwd: 'D:\\项目 A#1', source: 'vscode' }
  }
  const event = (type, turn = 'turn-1') =>
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-09-16T10:00:00Z',
      payload: { type, turn_id: turn, last_agent_message: 'PRIVATE TEXT' }
    }) + '\n'
  await fs.writeFile(file, JSON.stringify(metadata) + '\n' + event('task_complete', 'historical'))
  const notifications = []
  let monitor = new TaskMonitor(sessions, state, (_, tasks) => notifications.push(...tasks))
  try {
    await monitor.load()
    await monitor.setEnabled(true)
    await monitor.poll(true)
    assert.equal(monitor.snapshot().tasks.length, 0, 'historical results must not be imported')
    await fs.appendFile(file, event('task_started'))
    await monitor.poll(true)
    assert.equal(monitor.snapshot().tasks[0].status, 'running')
    assert.equal(monitor.snapshot().tasks[0].title, '测试会话标题')
    assert.equal(monitor.snapshot().tasks[0].startedAt, '2026-09-16T10:00:00.000Z')
    const request = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '# Context from my IDE setup:\nignored context\n## My request:\n修复登录问题，并补充测试。'
          }
        ]
      }
    }
    await fs.appendFile(file, JSON.stringify(request) + '\n')
    await monitor.poll(true)
    assert.equal(monitor.snapshot().tasks[0].requestSummary, '修复登录问题，并补充测试。')
    assert.equal(
      turnRequestSummary({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '<environment_context>private context</environment_context>'
        }
      }),
      undefined
    )
    const end = event('task_complete')
    await fs.appendFile(file, end.slice(0, 70))
    await monitor.poll(true)
    assert.equal(notifications.length, 0, 'partial line must not end a task')
    await fs.appendFile(file, end.slice(70))
    await monitor.poll(true)
    assert.equal(notifications.length, 1)
    assert.deepEqual(taskNotificationContent([notifications[0]], false), {
      title: '测试会话标题 · 本轮结束',
      body: '修复登录问题，并补充测试。'
    })
    assert.equal('unread' in monitor.snapshot().tasks[0], false, 'no review state is required')
    assert.equal(
      monitor.snapshot().tasks[0].startedAt,
      '2026-09-16T10:00:00.000Z',
      'end without timing preserves observed start'
    )
    const timed = taskFromEvent(
      {
        type: 'event_msg',
        timestamp: '2026-09-16T10:01:00Z',
        payload: {
          type: 'task_complete',
          turn_id: 'timed',
          started_at: '2026-09-16T10:00:00Z',
          duration_ms: 60000
        }
      },
      sessionMetadata(metadata)
    )
    assert.equal(timed.durationMs, 60000)
    await fs.appendFile(file, end + event('task_started'))
    await monitor.poll(true)
    assert.equal(notifications.length, 1, 'duplicate completion and late start must not re-notify')
    assert.equal(monitor.snapshot().tasks[0].status, 'completed')
    await monitor.stop()
    assert.ok(
      !(await fs.readFile(state, 'utf8')).includes('PRIVATE TEXT'),
      'do not persist assistant responses'
    )
    monitor = new TaskMonitor(sessions, state, (_, tasks) => notifications.push(...tasks))
    await monitor.load()
    assert.equal(
      monitor.snapshot().tasks[0].status,
      'completed',
      'results survive restart without review actions'
    )
    await monitor.setEnabled(true)
    await fs.appendFile(file, end)
    await monitor.poll(true)
    assert.equal(notifications.length, 1, 'replayed result does not notify again')
    const child = {
      ...metadata,
      payload: { ...metadata.payload, id: 'child', source: { subagent: { other: 'guardian' } } }
    }
    await fs.writeFile(
      path.join(sessions, 'child.jsonl'),
      JSON.stringify(child) + '\n' + event('task_complete')
    )
    await monitor.poll(true)
    assert.equal(notifications.length, 1, 'internal subagents do not notify')
    await fs.appendFile(file, event('task_started', 'turn-2') + event('turn_aborted', 'turn-2'))
    await monitor.poll(true)
    assert.equal(notifications.at(-1).status, 'interrupted')
    assert.equal(monitor.snapshot().tasks.length, 1, 'multiple turns share one session card')
    await fs.appendFile(file, event('task_started', 'turn-3'))
    await monitor.poll(true)
    assert.equal(monitor.snapshot().tasks.length, 1)
    assert.equal(monitor.snapshot().tasks[0].status, 'running')
    await monitor.setEnabled(false)
    await fs.appendFile(file, event('task_complete', 'paused'))
    await monitor.setEnabled(true)
    await monitor.poll(true)
    assert.equal(notifications.length, 2, 're-enabling does not replay paused events')
    // 新文件和包含多字节路径的分段文件头。
    const newer = path.join(sessions, 'new.jsonl')
    const header = Buffer.from(
      JSON.stringify({ ...metadata, payload: { ...metadata.payload, id: 'session-2' } }) + '\n'
    )
    const split = header.indexOf(Buffer.from('项目')) + 1
    await fs.writeFile(newer, header.subarray(0, split))
    await monitor.poll(true)
    await fs.appendFile(
      newer,
      Buffer.concat([header.subarray(split), Buffer.from(event('task_complete'))])
    )
    await monitor.poll(true)
    assert.equal(notifications.length, 3)
    assert.equal(notifications.at(-1).cwd, metadata.payload.cwd)
    await monitor.setMuted('session-1:turn-3', true)
    await fs.appendFile(
      file,
      event('task_started', 'muted-round') + event('task_complete', 'muted-round')
    )
    await monitor.poll(true)
    assert.equal(notifications.length, 3, 'muted sessions remain visible without notifications')
    assert.equal(monitor.snapshot().tasks.find((t) => t.threadId === 'session-1').muted, true)
    assert.equal(
      monitor.snapshot().tasks.find((t) => t.threadId === 'session-1').requestSummary,
      undefined,
      'do not reuse a prior turn request'
    )
    await monitor.remove('session-1:muted-round')
    await fs.appendFile(file, event('task_complete', 'removed-round'))
    await monitor.poll(true)
    assert.equal(notifications.length, 3)
    assert.equal(
      monitor.snapshot().tasks.some((t) => t.threadId === 'session-1'),
      false
    )
    await monitor.stop()
    monitor = new TaskMonitor(sessions, state, (_, tasks) => notifications.push(...tasks))
    await monitor.load()
    await monitor.setEnabled(true)
    assert.equal(monitor.snapshot().removed[0].threadId, 'session-1', 'removal survives restart')
    await monitor.restore('session-1')
    assert.equal(
      monitor.snapshot().tasks.find((t) => t.threadId === 'session-1').muted,
      true,
      'mute survives restart and restore'
    )
    await monitor.setMuted('session-1:muted-round', false)
    assert.equal(notifications.length, 3, 'restoring does not replay old notifications')
    await fs.appendFile(
      file,
      event('task_started', 'restored-round') + event('task_complete', 'restored-round')
    )
    await monitor.poll(true)
    assert.equal(notifications.length, 4, 'restored sessions notify on new events')
    const legacyFile = path.join(temp, 'legacy.json')
    await fs.writeFile(legacyFile, JSON.stringify(monitor.snapshot().tasks))
    const legacy = new TaskMonitor(sessions, legacyFile, () => {})
    await legacy.load()
    assert.equal(
      legacy.snapshot().tasks.length,
      monitor.snapshot().tasks.length,
      'old array state remains readable'
    )
    assert.equal(sessionMetadata(child), undefined)
    assert.equal(
      taskFromEvent(
        { type: 'event_msg', payload: { type: 'token_count' } },
        sessionMetadata(metadata)
      ),
      undefined
    )
  } finally {
    await monitor.stop()
    assert.equal(path.dirname(temp), os.tmpdir())
    await fs.rm(temp, { recursive: true, force: true })
  }
})
