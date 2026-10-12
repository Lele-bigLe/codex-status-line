export type CodexPermissionMode = 'read-only' | 'workspace-write'

export interface ExecutionThread {
  threadId: string
  permission: CodexPermissionMode
}

export interface CodexRuntimeInfo {
  executable: string
  version: string
}

export interface CodexSessionConfiguration {
  model?: string
  reasoningEffort?: string | null
}

export function normalizeExecutionThreads(value: unknown, legacy?: unknown): ExecutionThread[] {
  const validId = (id: unknown): id is string =>
    typeof id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)
  if (value === undefined)
    return validId(legacy) ? [{ threadId: legacy, permission: 'read-only' }] : []
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('会话授权列表格式无效，最多允许 100 个会话。')
  const seen = new Set<string>()
  return value.map((entry) => {
    const item = entry as Partial<ExecutionThread> | null
    if (
      !item ||
      !validId(item.threadId) ||
      seen.has(item.threadId) ||
      (item.permission !== 'read-only' && item.permission !== 'workspace-write')
    )
      throw new Error('会话 ID 或权限无效，且不能重复授权同一会话。')
    seen.add(item.threadId)
    return { threadId: item.threadId, permission: item.permission }
  })
}

export interface FeishuSettings {
  enabled: boolean
  mentionAll: boolean
  webhook: string
  secret: string
  receiveEnabled: boolean
  appId: string
  appSecret: string
  allowedChatId: string
  allowedUserId: string
  executionEnabled: boolean
  executionThreads: ExecutionThread[]
  codexExecutable: string
}

export interface FeishuReceiverStatus {
  phase: 'stopped' | 'starting' | 'listening' | 'received' | 'replied' | 'failed'
  receivedAt?: string
  repliedAt?: string
  target?: string
  issue?: string
  codexRuntime?: CodexRuntimeInfo
}

export interface FeishuStatus {
  enabled: boolean
  phase: 'idle' | 'sending' | 'sent' | 'failed'
  updatedAt?: string
  issue?: string
}

export const DEFAULT_FEISHU_SETTINGS: FeishuSettings = {
  enabled: false,
  mentionAll: false,
  webhook: '',
  secret: '',
  receiveEnabled: false,
  appId: '',
  appSecret: '',
  allowedChatId: '',
  allowedUserId: '',
  executionEnabled: false,
  executionThreads: [],
  codexExecutable: ''
}

export const DEFAULT_FEISHU_STATUS: FeishuStatus = {
  enabled: false,
  phase: 'idle'
}
