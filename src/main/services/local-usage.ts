import { promises as fs } from 'node:fs'
import path from 'node:path'
import { equivalentCost, type LocalModelUsage, type ModelPrice } from '../../shared/estimation'

interface Cursor {
  offset: number
  model: string
  signature?: string
  skipLine?: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function readUsageRecord(value: unknown, cursor: Cursor): LocalModelUsage | undefined {
  const event = record(value)
  const payload = record(event?.payload)
  if (!event || !payload) return undefined
  if (event.type === 'turn_context' || event.type === 'session_meta') {
    if (typeof payload.model === 'string' && payload.model.length <= 100)
      cursor.model = payload.model
    return undefined
  }
  if (event.type !== 'event_msg' || payload.type !== 'token_count') return undefined
  const info = record(payload.info)
  const total = record(info?.total_token_usage)
  const last = record(info?.last_token_usage)
  if (!total || !last) return undefined
  const totals = [
    total.input_tokens,
    total.cached_input_tokens ?? 0,
    total.cache_write_input_tokens ?? 0,
    total.output_tokens
  ]
  if (
    !totals.every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  ) {
    throw new Error('Invalid cumulative token counters')
  }
  const signature = JSON.stringify(totals)
  if (signature === cursor.signature) return undefined
  cursor.signature = signature
  const fields = [
    last.input_tokens,
    last.cached_input_tokens ?? 0,
    last.cache_write_input_tokens ?? 0,
    last.output_tokens
  ]
  if (
    !fields.every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  ) {
    throw new Error('Invalid token counters')
  }
  const [input, cached, write, output] = fields as number[]
  if (cached + write > input) throw new Error('Invalid cached token counters')
  const usage = { model: cursor.model, input, cached, write, output, requests: 1 }
  return { ...usage, cost: equivalentCost(usage) }
}

export class LocalUsageReader {
  private cursors = new Map<string, Cursor>()
  private models = new Map<string, LocalModelUsage>()
  private initialized = false
  private failures = 0
  private startedAt = Date.now()
  private seenEvents = new Set<string>()

  async scan(
    root: string,
    prices: Record<string, ModelPrice>
  ): Promise<{ models: LocalModelUsage[]; cost: number; unpriced: number; issue: boolean }> {
    let issue = false
    try {
      const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const file = path.join(entry.parentPath, entry.name)
        try {
          const stat = await fs.stat(file)
          let cursor = this.cursors.get(file)
          if (!cursor) {
            // 不回填历史日志：它们可能属于别的账号或复制出来的会话。
            cursor = { offset: stat.size, model: 'unknown' }
            this.cursors.set(file, cursor)
            if (!this.initialized) continue
            cursor.offset = 0
          }
          if (stat.size < cursor.offset) {
            cursor.offset = stat.size
            cursor.signature = undefined
            cursor.model = 'unknown'
            this.failures++
            issue = true
          }
          if (stat.size === cursor.offset) continue
          // 单次最多读取 8 MiB；截断或缺失用量会阻止总额度校准，不静默当作零。
          const length = Math.min(stat.size - cursor.offset, 8 * 1024 * 1024)
          const handle = await fs.open(file, 'r')
          let buffer: Buffer
          try {
            buffer = Buffer.alloc(length)
            const read = await handle.read(buffer, 0, length, cursor.offset)
            buffer = buffer.subarray(0, read.bytesRead)
          } finally {
            await handle.close()
          }
          const end = buffer.lastIndexOf(10)
          if (end < 0) {
            if (length === 8 * 1024 * 1024) {
              cursor.offset += buffer.length
              cursor.skipLine = true
              this.failures++
              issue = true
            }
            continue
          }
          const lines = buffer.subarray(0, end).toString('utf8').split('\n')
          if (cursor.skipLine) {
            lines.shift()
            cursor.skipLine = false
          }
          cursor.offset += end + 1
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const event = JSON.parse(line)
              const usage = readUsageRecord(event, cursor)
              if (!usage) continue
              const timestamp = Date.parse(event.timestamp)
              if (!Number.isFinite(timestamp)) throw new Error('Missing usage timestamp')
              if (timestamp < this.startedAt || timestamp > Date.now() + 60000) continue
              const eventKey = `${timestamp}:${usage.model}:${cursor.signature}`
              if (this.seenEvents.has(eventKey)) continue
              this.seenEvents.add(eventKey)
              const current = this.models.get(usage.model)
              if (!current) {
                this.models.set(usage.model, usage)
                continue
              }
              current.input += usage.input
              current.cached += usage.cached
              current.write += usage.write
              current.output += usage.output
              current.requests++
              current.cost = equivalentCost(current)
            } catch {
              this.failures++
              issue = true
            }
          }
          if (length === 8 * 1024 * 1024 && stat.size > cursor.offset) issue = true
        } catch {
          this.failures++
          issue = true
        }
      }
      this.initialized = true
    } catch {
      this.failures++
      issue = true
    }
    const models = [...this.models.values()].map((model) => ({
      ...model,
      cost: equivalentCost(model, prices)
    }))
    return {
      models,
      cost: models.reduce((sum, model) => sum + (model.cost ?? 0), 0),
      unpriced:
        this.failures +
        models.reduce((sum, model) => sum + (model.cost === undefined ? model.requests : 0), 0),
      issue
    }
  }
}
