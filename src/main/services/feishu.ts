import { net, safeStorage } from 'electron'
import { createHmac } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  DEFAULT_FEISHU_SETTINGS,
  DEFAULT_FEISHU_STATUS,
  type FeishuSettings,
  type FeishuStatus
} from '../../shared/feishu'

class FeishuRequestError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message)
  }
}

function validateSettings(value: unknown): FeishuSettings {
  const input = value as Partial<FeishuSettings> | null
  if (
    !input ||
    typeof input.enabled !== 'boolean' ||
    (input.mentionAll !== undefined && typeof input.mentionAll !== 'boolean') ||
    typeof input.webhook !== 'string' ||
    typeof input.secret !== 'string' ||
    input.webhook.length > 512 ||
    input.secret.length > 256
  ) throw new Error('飞书配置格式无效 / Invalid Feishu settings')

  const settings = {
    enabled: input.enabled,
    mentionAll: input.mentionAll ?? DEFAULT_FEISHU_SETTINGS.mentionAll,
    webhook: input.webhook.trim(),
    secret: input.secret.trim()
  }
  if (settings.webhook) {
    // 只接受飞书官方群机器人地址，避免把通知和签名发送到其他服务。
    if (!/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(settings.webhook)) {
      throw new Error('请填写完整的飞书群机器人 Webhook 地址 / Invalid Feishu webhook URL')
    }
  } else if (settings.enabled) {
    throw new Error('开启飞书通知前请填写 Webhook 地址 / A webhook URL is required')
  }
  if (/[\r\n]/.test(settings.secret)) {
    throw new Error('签名密钥不能包含换行 / The signing secret cannot contain line breaks')
  }
  return settings
}

function requireEncryption(): void {
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
  ) throw new Error('系统安全存储不可用，无法保存飞书密钥 / Secure credential storage is unavailable')
}

export class FeishuNotifier {
  private settings: FeishuSettings = { ...DEFAULT_FEISHU_SETTINGS }
  private status: FeishuStatus = { ...DEFAULT_FEISHU_STATUS }
  private writes: Promise<void> = Promise.resolve()
  private sends: Promise<void> = Promise.resolve()
  private nextSendAt = 0
  private revision = 0
  private stopped = false
  private controller?: AbortController

  constructor(private file: string, private onStatus: (status: FeishuStatus) => void) {}

  async load(): Promise<void> {
    try {
      const encrypted = await fs.readFile(this.file)
      requireEncryption()
      this.settings = validateSettings(JSON.parse(safeStorage.decryptString(encrypted)))
      this.setStatus('idle')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.setStatus('failed', '飞书配置读取或解密失败，请重新保存 / Could not load or decrypt Feishu settings')
      }
    }
  }

  getSettings(): FeishuSettings {
    return { ...this.settings }
  }

  getStatus(): FeishuStatus {
    return { ...this.status }
  }

  async save(value: unknown): Promise<FeishuSettings> {
    const settings = validateSettings(value)
    const write = this.writes.then(async () => {
      requireEncryption()
      try {
        const encrypted = safeStorage.encryptString(JSON.stringify(settings))
        await fs.mkdir(dirname(this.file), { recursive: true })
        await fs.writeFile(`${this.file}.tmp`, encrypted, { mode: 0o600 })
        await fs.rename(`${this.file}.tmp`, this.file)
      } catch {
        throw new Error('飞书配置加密或保存失败 / Could not encrypt or save Feishu settings')
      }
      this.settings = settings
      this.revision += 1
      this.setStatus('idle')
    })
    this.writes = write.catch(() => {})
    await write
    return this.getSettings()
  }

  send(getContent: () => { title: string; body: string } | undefined, test = false): Promise<void> {
    const revision = this.revision
    const cancelled = (): boolean =>
      this.stopped || revision !== this.revision || (!test && !this.settings.enabled)
    const send = this.sends.then(async () => {
      if (cancelled()) return
      // 串行发送并间隔至少一秒，避免多个轮次同时结束触发机器人频控。
      await delay(Math.max(0, this.nextSendAt - Date.now()))
      if (cancelled()) return
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (cancelled()) return
        const content = getContent()
        if (!content) {
          if (this.status.phase === 'sending') this.setStatus('idle')
          return
        }
        this.setStatus('sending')
        this.nextSendAt = Date.now() + 1000
        try {
          await this.post(content)
          if (!cancelled()) this.setStatus('sent')
          return
        } catch (error) {
          if (cancelled()) return
          // 仅在明确被限流时重试；超时的请求可能已送达，重发会造成重复提醒。
          if (attempt === 0 && error instanceof FeishuRequestError && error.retryAfterMs !== undefined) {
            await delay(error.retryAfterMs)
            continue
          }
          this.setStatus('failed', error instanceof FeishuRequestError
            ? error.message
            : '飞书推送失败 / Feishu notification failed')
          return
        }
      }
    })
    this.sends = send.catch(() => {
      if (!cancelled()) this.setStatus('failed', '飞书推送失败 / Feishu notification failed')
    })
    return this.sends
  }

  stop(): void {
    this.stopped = true
    this.controller?.abort()
  }

  private setStatus(phase: FeishuStatus['phase'], issue?: string): void {
    this.status = {
      enabled: this.settings.enabled,
      phase,
      updatedAt: phase === 'idle' ? undefined : new Date().toISOString(),
      issue
    }
    this.onStatus(this.getStatus())
  }

  private async post(content: { title: string; body: string }): Promise<void> {
    if (!this.settings.webhook) throw new FeishuRequestError('请先保存 Webhook 地址 / Save a webhook URL first')
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const text = `Codex Status\n${content.title}\n${content.body}`.trim()
    const body = {
      msg_type: 'text',
      content: { text: this.settings.mentionAll ? `${text}\n<at user_id="all">所有人</at>` : text },
      ...(this.settings.secret ? {
        timestamp,
        sign: createHmac('sha256', `${timestamp}\n${this.settings.secret}`).update('').digest('base64')
      } : {})
    }
    const controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await net.fetch(this.settings.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal
      })
      if (!response.ok) {
        await response.body?.cancel()
        const retrySeconds = Number(response.headers.get('retry-after') ?? 3)
        throw new FeishuRequestError(`飞书接口返回 HTTP ${response.status} / Feishu HTTP ${response.status}`,
          response.status === 429 && Number.isFinite(retrySeconds) && retrySeconds <= 30
            ? Math.max(1000, retrySeconds * 1000)
            : undefined)
      }
      const result = await response.json().catch(() => {
        throw new FeishuRequestError('飞书响应格式无效 / Invalid Feishu response')
      }) as { code?: number; StatusCode?: number } | null
      const code = result?.code ?? result?.StatusCode
      if (code !== 0) {
        const hint = code === 19021 ? '，请检查签名密钥和系统时间 / Check the signing secret and system clock'
          : code === 19024 ? '，请检查机器人关键词 / Check the bot keywords'
          : code === 19022 ? '，请检查 IP 白名单 / Check the IP allowlist'
          : code === 19001 ? '，请检查 Webhook 地址 / Check the webhook URL' : ''
        throw new FeishuRequestError(
          `飞书拒绝消息 / Feishu rejected the message (${typeof code === 'number' ? code : 'UNKNOWN'})${hint}`,
          code === 11232 || code === 99991400 ? 3000 : undefined
        )
      }
    } catch (error) {
      if (error instanceof FeishuRequestError) throw error
      // 不展示网络异常原文或服务端 msg，避免它们携带 Webhook 和密钥。
      throw new FeishuRequestError(controller.signal.aborted
        ? '请求超时，送达状态未知 / Request timed out; delivery is unknown'
        : '飞书网络请求失败，请检查网络或系统代理 / Check your network or system proxy')
    } finally {
      clearTimeout(timeout)
      this.controller = undefined
    }
  }
}
