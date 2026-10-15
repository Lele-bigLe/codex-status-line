import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { TaskRecord, TasksSnapshot } from '../../shared/tasks'

interface SessionMetadata {
  threadId: string
  cwd: string
  client: TaskRecord['client']
}
interface Cursor {
  baseline?: boolean
  offset: number
  ino: number
  pending: Buffer
  skipping: boolean
  metadata?: SessionMetadata
  recoveringUntil?: number
  recoveredTurns?: Set<string>
}
const MAX_LINE = 1024 * 1024
const ID = /^[a-zA-Z0-9_-]{1,100}$/
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

export function turnRequestSummary(value: unknown): string | undefined {
  const item = record(value),
    payload = record(item?.payload)
  let text: string | undefined
  if (
    item?.type === 'event_msg' &&
    payload?.type === 'user_message' &&
    typeof payload.message === 'string'
  )
    text = payload.message
  if (
    item?.type === 'response_item' &&
    payload?.type === 'message' &&
    payload.role === 'user' &&
    Array.isArray(payload.content)
  ) {
    text = payload.content
      .map(record)
      .filter((part) => part?.type === 'input_text' && typeof part.text === 'string')
      .map((part) => part!.text)
      .join('\n')
  }
  if (!text) return
  const request = text.indexOf('## My request:')
  if (request >= 0) text = text.slice(request + '## My request:'.length)
  else if (/^\s*(<|# AGENTS\.md|# Context from my IDE)/.test(text)) return
  const summary = text.replace(/\s+/g, ' ').trim().slice(0, 220)
  return summary || undefined
}

export function sessionMetadata(value: unknown): SessionMetadata | undefined {
  const item = record(value)
  const payload = record(item?.payload)
  if (
    item?.type !== 'session_meta' ||
    !payload ||
    typeof payload.id !== 'string' ||
    !ID.test(payload.id) ||
    typeof payload.cwd !== 'string' ||
    payload.cwd.length > 4096
  )
    return
  // 子代理与主会话会分别结束；只提醒用户直接使用的会话。
  if (typeof payload.source === 'object') return
  if (payload.service_name === 'codex-status-cycle-trigger' || payload.serviceName === 'codex-status-cycle-trigger') return
  return {
    threadId: payload.id,
    cwd: payload.cwd,
    client:
      payload.source === 'vscode' || payload.originator === 'codex_vscode'
        ? 'vscode'
        : payload.source === 'cli'
          ? 'cli'
          : 'unknown'
  }
}

export function taskFromEvent(value: unknown, metadata: SessionMetadata): TaskRecord | undefined {
  const item = record(value)
  const payload = record(item?.payload)
  if (
    item?.type !== 'event_msg' ||
    !payload ||
    typeof payload.turn_id !== 'string' ||
    !ID.test(payload.turn_id) ||
    typeof item.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(item.timestamp))
  )
    return
  const status =
    payload.type === 'task_started'
      ? 'running'
      : payload.type === 'task_complete'
        ? 'completed'
        : payload.type === 'turn_aborted'
          ? 'interrupted'
          : undefined
  if (!status) return
  const startedAt =
    typeof payload.started_at === 'number' && payload.started_at > 0 &&
    Number.isFinite(new Date(payload.started_at * 1000).getTime())
      ? new Date(payload.started_at * 1000).toISOString()
      : typeof payload.started_at === 'string' && Number.isFinite(Date.parse(payload.started_at))
        ? new Date(payload.started_at).toISOString()
        : status === 'running'
          ? new Date(item.timestamp).toISOString()
          : undefined
  return {
    ...metadata,
    id: `${metadata.threadId}:${payload.turn_id}`,
    turnId: payload.turn_id,
    status,
    startedAt,
    durationMs:
      typeof payload.duration_ms === 'number' &&
      Number.isFinite(payload.duration_ms) &&
      payload.duration_ms >= 0
        ? payload.duration_ms
        : undefined,
    updatedAt: new Date(item.timestamp).toISOString()
  }
}

export class TaskMonitor {
  private tasks = new Map<string, TaskRecord>()
  private cursors = new Map<string, Cursor>()
  private dirty = new Set<string>()
  private watcher?: FSWatcher
  private timer?: NodeJS.Timeout
  private changeTimer?: NodeJS.Timeout
  private readAgain = false
  private active = false
  private busy?: Promise<void>
  private lastScan = 0
  private issue?: string
  private changed = false
  private notifications: TaskRecord[] = []
  private writes: Promise<void> = Promise.resolve()
  private canPersist = true
  private muted = new Set<string>()
  private removed = new Map<string, string>()
  private activeTurns = new Map<string, string>()
  private questionCalls = new Set<string>()

  constructor(
    private root: string,
    private stateFile: string,
    private onChanged: (snapshot: TasksSnapshot, notifications: TaskRecord[]) => void
  ) {}

  snapshot(): TasksSnapshot {
    const sessions = new Map<string, TaskRecord>()
    for (const task of this.tasks.values()) {
      if (this.removed.has(task.threadId)) continue
      const previous = sessions.get(task.threadId)
      const latest = !previous || task.updatedAt >= previous.updatedAt ? task : previous
      sessions.set(task.threadId, {
        ...latest,
        muted: this.muted.has(task.threadId)
      })
    }
    return {
      tasks: [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      monitoring: this.active,
      removed: [...this.removed].map(([threadId, title]) => ({ threadId, title })),
      issue: this.issue
    }
  }

  async load(): Promise<void> {
    try {
      const stored: unknown = JSON.parse(await fs.readFile(this.stateFile, 'utf8'))
      const state = record(stored)
      const rows = Array.isArray(stored) ? stored : state?.tasks
      if (!Array.isArray(rows)) throw new Error('Invalid task state')
      if (Array.isArray(state?.muted))
        for (const id of state.muted) {
          if (typeof id === 'string' && ID.test(id)) this.muted.add(id)
        }
      if (Array.isArray(state?.removed))
        for (const value of state.removed) {
          const entry = record(value)
          if (
            typeof entry?.threadId === 'string' &&
            ID.test(entry.threadId) &&
            typeof entry.title === 'string'
          )
            this.removed.set(entry.threadId, entry.title.slice(0, 160))
        }
      for (const value of rows) {
        const t = record(value)
        if (
          !t ||
          typeof t.threadId !== 'string' ||
          !ID.test(t.threadId) ||
          typeof t.turnId !== 'string' ||
          !ID.test(t.turnId) ||
          t.id !== `${t.threadId}:${t.turnId}` ||
          typeof t.cwd !== 'string' ||
          t.cwd.length > 4096 ||
          typeof t.updatedAt !== 'string' ||
          !Number.isFinite(Date.parse(t.updatedAt)) ||
          !['running', 'waiting_input', 'completed', 'interrupted', 'unknown'].includes(String(t.status)) ||
          !['vscode', 'cli', 'unknown'].includes(String(t.client))
        )
          continue
        delete t.unread // 兼容旧记录；不再维护待查看状态。
        const task = t as unknown as TaskRecord
        this.tasks.set(task.id, {
          ...task,
          title: typeof task.title === 'string' ? task.title.slice(0, 160) : undefined,
          requestSummary:
            typeof task.requestSummary === 'string' ? task.requestSummary.slice(0, 220) : undefined,
          pendingQuestions: Array.isArray(task.pendingQuestions)
            ? task.pendingQuestions.filter((question) =>
              question && typeof question.callId === 'string' && question.callId.length <= 200 &&
              typeof question.text === 'string' && question.text.length <= 220 &&
              typeof question.asynchronous === 'boolean'
            ).slice(0, 20)
            : undefined,
          endedAt: typeof task.endedAt === 'string' && Number.isFinite(Date.parse(task.endedAt))
            ? task.endedAt : undefined,
          startedAt:
            typeof task.startedAt === 'string' && Number.isFinite(Date.parse(task.startedAt))
              ? task.startedAt
              : undefined,
          durationMs:
            typeof task.durationMs === 'number' &&
            Number.isFinite(task.durationMs) &&
            task.durationMs >= 0
              ? task.durationMs
              : undefined,
          status: task.status === 'running' ? 'unknown' : task.status
        })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.canPersist = false
        this.issue = '任务记录读取失败 / Could not read task history'
      }
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.active = false
    clearInterval(this.timer)
    clearTimeout(this.changeTimer)
    this.changeTimer = undefined
    this.readAgain = false
    this.watcher?.close()
    this.watcher = undefined
    await this.busy
    this.cursors.clear()
    this.dirty.clear()
    this.activeTurns.clear()
    this.questionCalls.clear()
    for (const task of this.tasks.values()) {
      if (task.status === 'running' || task.status === 'waiting_input') task.status = 'unknown'
    }
    this.active = enabled
    if (enabled) {
      // 回读已监视会话以恢复状态；历史事件不补发通知。
      await this.scan(true)
      await this.poll()
      this.timer = setInterval(() => {
        void this.poll()
      }, 1500)
    }
    await this.readTitles()
    this.publish()
  }

  private async scan(baseline = false): Promise<void> {
    this.lastScan = Date.now()
    try {
      const entries = await fs.readdir(this.root, { recursive: true, withFileTypes: true })
      const found = new Set<string>()
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const file = path.join(entry.parentPath, entry.name)
        found.add(file)
        const stat = await fs.stat(file).catch(() => undefined)
        if (!stat) continue
        if (baseline) {
          const recover = [...this.tasks.values()].some((task) =>
            entry.name.endsWith(`-${task.threadId}.jsonl`)
          )
          this.cursors.set(file, {
            offset: recover ? Math.max(0, stat.size - 8 * MAX_LINE) : stat.size,
            ino: stat.ino,
            pending: Buffer.alloc(0),
            skipping: false,
            baseline: true,
            recoveringUntil: recover ? stat.size : undefined,
            recoveredTurns: recover ? new Set() : undefined
          })
          if (recover) this.dirty.add(file)
        } else {
          const cursor = this.cursors.get(file)
          if (!cursor || cursor.offset !== stat.size || cursor.ino !== stat.ino)
            this.dirty.add(file)
        }
      }
      for (const file of this.cursors.keys()) if (!found.has(file)) this.cursors.delete(file)
      if (!this.watcher) {
        try {
          this.watcher = watch(this.root, { recursive: true }, (_, filename) => {
            if (!filename || !filename.endsWith('.jsonl')) return
            const file = path.resolve(this.root, filename)
            const relative = path.relative(this.root, file)
            if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
              this.dirty.add(file)
              this.schedulePoll()
            }
          })
          this.watcher.on('error', () => {
            this.watcher?.close()
            this.watcher = undefined
          })
        } catch {
          /* 无递归文件通知的平台仍通过定期扫描监视。 */
        }
      }
      if (this.issue?.startsWith('会话目录')) {
        this.issue = undefined
        this.changed = true
      }
    } catch {
      this.issue = '会话目录不可读取，正在重试 / Session directory unavailable; retrying'
      this.changed = true
    }
  }

  private schedulePoll(): void {
    if (!this.active) return
    this.readAgain = true
    if (this.busy || this.changeTimer) return
    // 合并一小段连续写入；不重置计时器，避免持续输出把结束通知一直推迟。
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined
      void this.poll()
    }, 50)
  }

  poll(rescan = false): Promise<void> {
    if (!this.active) return Promise.resolve()
    if (this.busy) return rescan ? this.busy.then(() => this.poll(true)) : this.busy
    clearTimeout(this.changeTimer)
    this.changeTimer = undefined
    this.readAgain = false
    this.busy = this.readChanges(rescan).finally(() => {
      this.busy = undefined
      if (this.readAgain) this.schedulePoll()
    })
    return this.busy
  }

  private async readChanges(rescan: boolean): Promise<void> {
    // 已知变更先读取并发布，结束通知不必排在整个历史目录的扫描后面。
    await this.readDirtyFiles()
    if (rescan || Date.now() - this.lastScan >= (this.watcher ? 30000 : 5000)) {
      await this.scan()
      await this.readTitles()
      await this.readDirtyFiles()
    }
  }

  private async readDirtyFiles(): Promise<void> {
    const files = [...this.dirty]
    this.dirty.clear()
    let readFailed = false
    for (const file of files) {
      if (!this.active) break
      try {
        await this.readFile(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          readFailed = true
          this.dirty.add(file)
          this.issue = '部分会话读取失败，正在重试 / Some sessions could not be read; retrying'
          this.changed = true
        }
      }
    }
    if (files.length && !readFailed && !this.dirty.size && this.issue?.startsWith('部分会话')) {
      this.issue = undefined
      this.changed = true
    }
    if (this.changed) {
      await this.readTitles()
      this.publish()
    }
  }

  private async readTitles(): Promise<void> {
    if (!this.tasks.size) return
    // 仅读取本机会话索引中的名称，不截取提示词或最终回复作为标题。
    const handle = await fs
      .open(path.join(path.dirname(this.root), 'session_index.jsonl'), 'r')
      .catch(() => undefined)
    if (!handle) return
    try {
      const { size } = await handle.stat()
      const offset = Math.max(0, size - MAX_LINE)
      const buffer = Buffer.alloc(size - offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
      if (offset) lines.shift()
      const titles = new Map<string, string>()
      for (const line of lines) {
        try {
          const entry = record(JSON.parse(line))
          if (typeof entry?.id === 'string' && typeof entry.thread_name === 'string') {
            const title = entry.thread_name.replace(/\s+/g, ' ').trim().slice(0, 160)
            if (title) titles.set(entry.id, title)
          }
        } catch {
          /* 忽略尚未写完的索引行。 */
        }
      }
      for (const task of this.tasks.values()) {
        const title = titles.get(task.threadId)
        if (title && title !== task.title) {
          task.title = title
          this.changed = true
        }
      }
    } catch {
      /* 索引非必需，缺失时仍以会话 ID 显示。 */
    } finally {
      await handle.close()
    }
  }

  private async readFile(file: string): Promise<void> {
    const handle = await fs.open(file, 'r')
    try {
      const stat = await handle.stat()
      let cursor = this.cursors.get(file)
      if (!cursor || cursor.ino !== stat.ino || stat.size < cursor.offset) {
        cursor = { offset: 0, ino: stat.ino, pending: Buffer.alloc(0), skipping: false }
        this.cursors.set(file, cursor)
      }
      if (cursor.baseline) {
        if (cursor.offset > 0) {
          const lastByte = Buffer.alloc(1)
          await handle.read(lastByte, 0, 1, cursor.offset - 1)
          cursor.skipping = lastByte[0] !== 10
        }
        cursor.baseline = false
      }
      if (!cursor.metadata) {
        const header = Buffer.alloc(Math.min(stat.size, MAX_LINE))
        const { bytesRead } = await handle.read(header, 0, header.length, 0)
        const newline = header.subarray(0, bytesRead).indexOf(10)
        if (newline < 0) return
        try {
          cursor.metadata = sessionMetadata(
            JSON.parse(header.subarray(0, newline).toString('utf8'))
          )
        } catch {
          /* 未识别的格式不推测完成。 */
        }
        if (!cursor.metadata) {
          cursor.offset = stat.size
          return
        }
      }
      if (this.removed.has(cursor.metadata.threadId)) {
        cursor.offset = stat.size
        cursor.pending = Buffer.alloc(0)
        cursor.skipping = false
        return
      }
      if (!this.activeTurns.has(cursor.metadata.threadId)) {
        const threadId = cursor.metadata.threadId
        const latest = [...this.tasks.values()]
          .filter((task) => task.threadId === threadId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
        if (latest && (latest.status === 'unknown' || latest.status === 'waiting_input'))
          this.activeTurns.set(threadId, latest.id)
      }
      // 每次最多处理 8 MiB，其余留到下一轮；大工具输出不保留在内存中。
      const end = Math.min(stat.size, cursor.offset + 8 * MAX_LINE)
      while (cursor.offset < end) {
        const chunk = Buffer.alloc(Math.min(256 * 1024, end - cursor.offset))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, cursor.offset)
        if (!bytesRead) break
        cursor.offset += bytesRead
        const data = Buffer.concat([cursor.pending, chunk.subarray(0, bytesRead)])
        let start = 0
        for (let newline = data.indexOf(10); newline >= 0; newline = data.indexOf(10, start)) {
          if (!cursor.skipping && newline - start <= MAX_LINE) {
            try {
              this.consume(
                JSON.parse(data.subarray(start, newline).toString('utf8')),
                cursor.metadata,
                cursor.recoveringUntil === undefined ||
                  cursor.offset - data.length + newline + 1 > cursor.recoveringUntil,
                cursor.recoveredTurns
              )
            } catch {
              /* 跳过无效日志行。 */
            }
          }
          cursor.skipping = false
          start = newline + 1
        }
        cursor.pending = Buffer.from(data.subarray(start))
        if (cursor.pending.length > MAX_LINE || cursor.skipping) {
          cursor.pending = Buffer.alloc(0)
          cursor.skipping = true
        }
      }
      if (cursor.offset < stat.size) {
        this.dirty.add(file)
        this.schedulePoll()
      }
      if (cursor.recoveringUntil !== undefined && cursor.offset >= cursor.recoveringUntil) {
        cursor.recoveringUntil = undefined
        cursor.recoveredTurns = undefined
      }
    } finally {
      await handle.close()
    }
  }

  private consume(value: unknown, metadata: SessionMetadata, notify = true, recoveredTurns?: Set<string>): void {
    if (this.removed.has(metadata.threadId)) return
    const item = record(value), payload = record(item?.payload)
    if (!payload || typeof item?.timestamp !== 'string' || !Number.isFinite(Date.parse(item.timestamp)))
      return
    const updatedAt = new Date(item.timestamp).toISOString()
    const task = taskFromEvent(value, metadata)
    if (!task) {
      const activeId = this.activeTurns.get(metadata.threadId)
      const active = activeId ? this.tasks.get(activeId) : undefined
      if (!active || updatedAt < active.updatedAt) return
      const source = record(record(record(item.metadata)?.retained_source)?.id)
      const turnId = payload.turn_id ?? source?.turn_id
      if (typeof turnId === 'string' && turnId !== active.turnId) return
      if (item.type !== 'response_item' && item.type !== 'event_msg') return
      const summary = turnRequestSummary(value)
      if (summary && summary !== active.requestSummary) {
        active.requestSummary = summary
        this.changed = true
      }
      const activity = item.type === 'response_item'
        ? ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'reasoning'].includes(String(payload.type)) ||
          (payload.type === 'message' && (payload.role === 'assistant' || Boolean(summary)))
        : ['agent_message', 'agent_reasoning', 'token_count', 'item_started', 'item_completed',
            'exec_command_begin', 'exec_command_end', 'mcp_tool_call_begin', 'mcp_tool_call_end'].includes(String(payload.type))
      let questions = active.pendingQuestions || []
      const name = typeof payload.name === 'string' ? payload.name.split('.').at(-1) : undefined
      const asking = (payload.type === 'function_call' || payload.type === 'custom_tool_call') &&
        (name === 'request_user_input' || name === 'request_user_input_async')
      let newQuestion = false
      let answeredQuestion = false
      const callKey = `${active.id}:${payload.call_id}`
      if (asking && typeof payload.call_id === 'string' && payload.call_id.length <= 200 &&
        !this.questionCalls.has(callKey)) {
        try {
          const args = record(JSON.parse(String(payload.arguments ?? payload.input)))
          if (Array.isArray(args?.questions) && !questions.some((q) => q.callId === payload.call_id)) {
            const added = args.questions.map(record).flatMap((q) => {
              const text = typeof q?.question === 'string' ? q.question : q?.title
              return typeof text === 'string' && text.trim()
                ? [{ callId: payload.call_id as string, text: text.replace(/\s+/g, ' ').trim().slice(0, 220),
                    asynchronous: name === 'request_user_input_async' }]
                : []
            })
            if (added.length) {
              questions = [...questions, ...added].slice(-20)
              newQuestion = true
              this.questionCalls.add(callKey)
            }
          }
        } catch {
          /* 尚未形成有效问题的工具调用不推测为等待回答。 */
        }
      }
      if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        let accepted = false
        try { accepted = record(JSON.parse(String(payload.output)))?.accepted === true } catch { /* 非 JSON 输出。 */ }
        questions = questions.filter((q) =>
          q.callId !== payload.call_id || (q.asynchronous && accepted)
        )
      }
      if (payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
        for (const part of payload.content.map(record)) {
          if (typeof part?.text !== 'string') continue
          const reply = part.text.trim().match(/^<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>$/)
          if (!reply) continue
          try {
            const answers: unknown = JSON.parse(reply[1])
            if (Array.isArray(answers)) {
              const answered = answers.map(record).flatMap((answer) =>
                typeof answer?.question === 'string' && typeof answer.answer === 'string'
                  ? [answer.question.replace(/\s+/g, ' ').trim().slice(0, 220)] : []
              )
              answeredQuestion = answered.length > 0
              questions = questions.filter((q) => !answered.includes(q.text))
            }
          } catch { /* 不把无法识别的回复当成已回答。 */ }
        }
      }
      const status = questions.length ? 'waiting_input' : active.endedAt ? 'completed'
        : !notify ? 'unknown' : activity || answeredQuestion ? 'running' : active.status
      if (active.status !== status || (active.pendingQuestions?.length || 0) !== questions.length || newQuestion) {
        active.status = status
        active.pendingQuestions = questions.length ? questions : undefined
        active.updatedAt = updatedAt
        this.changed = true
      }
      if (newQuestion && notify && !this.muted.has(active.threadId))
        this.notifications.push({ ...active })
      if (active.status === 'completed') this.activeTurns.delete(active.threadId)
      return
    }
    const previous = this.tasks.get(task.id)
    const replayStart = !notify && task.status === 'running' && !recoveredTurns?.has(task.id)
    if (replayStart) recoveredTurns?.add(task.id)
    // 同一轮的结束事件只接受一次，避免重复日志或重读再次提醒。
    if (
      previous && !replayStart &&
      (previous.status === 'completed' ||
        previous.status === 'interrupted' ||
        previous.updatedAt > task.updatedAt ||
        (previous.status === task.status && task.status !== 'running') ||
        (task.status === 'running' && previous.status !== 'unknown') ||
        (previous.endedAt && task.status === 'running'))
    )
      return
    task.startedAt ??= previous?.startedAt
    task.title = previous?.title
    task.requestSummary = previous?.requestSummary
    if (task.status === 'running' && notify && previous?.pendingQuestions?.length) {
      task.pendingQuestions = previous.pendingQuestions
      task.status = 'waiting_input'
    }
    if (task.status === 'completed') {
      task.endedAt = task.updatedAt
      task.pendingQuestions = previous?.pendingQuestions?.filter((q) => q.asynchronous)
      if (task.pendingQuestions?.length) task.status = 'waiting_input'
    }
    if (task.status === 'running' && !notify) task.status = 'unknown'
    if (task.status === 'running' || task.status === 'waiting_input' || task.status === 'unknown') {
      const activeId = this.activeTurns.get(task.threadId)
      const active = activeId ? this.tasks.get(activeId) : undefined
      if (!active || active.id === task.id || active.updatedAt <= task.updatedAt)
        this.activeTurns.set(task.threadId, task.id)
    } else if (this.activeTurns.get(task.threadId) === task.id) this.activeTurns.delete(task.threadId)
    this.tasks.set(task.id, task)
    this.changed = true
    if (notify && (task.status === 'completed' || task.status === 'interrupted') &&
      !this.muted.has(task.threadId)) this.notifications.push(task)
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id)
  }

  async setMuted(id: string, muted: boolean): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    if (muted) this.muted.add(task.threadId)
    else this.muted.delete(task.threadId)
    this.publish()
    await this.writes
  }

  async remove(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    this.removed.set(task.threadId, task.title || path.basename(task.cwd) || task.threadId)
    this.activeTurns.delete(task.threadId)
    for (const round of this.tasks.values())
      if (round.threadId === task.threadId) {
        if (round.status === 'running' || round.status === 'waiting_input') round.status = 'unknown'
      }
    this.publish()
    await this.writes
  }

  async restore(threadId: string): Promise<void> {
    if (!this.removed.has(threadId)) return
    // 先跳过移除期间追加的日志，恢复后只通知新的轮次。
    await this.busy
    await this.poll(true)
    for (const [file, cursor] of this.cursors)
      if (cursor.metadata?.threadId === threadId) {
        const stat = await fs.stat(file).catch(() => undefined)
        if (stat) {
          cursor.offset = stat.size
          cursor.ino = stat.ino
          cursor.pending = Buffer.alloc(0)
          cursor.baseline = true
          cursor.skipping = false
        }
      }
    this.removed.delete(threadId)
    this.publish()
    await this.writes
  }

  private publish(): void {
    // 保留当前运行/待回答轮次及最近 200 条历史记录。
    const viewed = [...this.tasks.values()]
      .filter((t) => this.activeTurns.get(t.threadId) !== t.id || t.status === 'unknown')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    for (const task of viewed.slice(200)) this.tasks.delete(task.id)
    this.changed = false
    const notifications = [...new Map(this.notifications.splice(0).map((task) => [task.id, task])).values()]
      .filter((task) => !this.muted.has(task.threadId) && !this.removed.has(task.threadId) &&
        (task.status !== 'waiting_input' || (this.activeTurns.get(task.threadId) === task.id &&
          this.tasks.get(task.id)?.status === 'waiting_input')))
      .map((task) => task.status === 'waiting_input' ? { ...this.tasks.get(task.id)! } : task)
    const snapshot = this.snapshot()
    this.onChanged(snapshot, notifications)
    // 无法读取原文件时保留它，不用空历史覆盖可能仍可恢复的数据。
    if (!this.canPersist) return
    const content = JSON.stringify({
      tasks: [...this.tasks.values()],
      muted: [...this.muted],
      removed: snapshot.removed
    })
    this.writes = this.writes
      .then(async () => {
        await fs.mkdir(path.dirname(this.stateFile), { recursive: true })
        await fs.writeFile(`${this.stateFile}.tmp`, content, 'utf8')
        await fs.rename(`${this.stateFile}.tmp`, this.stateFile)
      })
      .catch(() => {
        this.issue = '任务记录未保存 / Could not save task history'
        this.onChanged(this.snapshot(), [])
      })
  }

  async stop(): Promise<void> {
    this.active = false
    clearInterval(this.timer)
    clearTimeout(this.changeTimer)
    this.changeTimer = undefined
    this.readAgain = false
    this.watcher?.close()
    this.watcher = undefined
    await this.busy
    await this.writes
  }
}
