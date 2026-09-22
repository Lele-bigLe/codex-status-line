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
  executionThreadId: string
  codexExecutable: string
}

export interface FeishuReceiverStatus {
  phase: 'stopped' | 'starting' | 'listening' | 'received' | 'replied' | 'failed'
  receivedAt?: string
  repliedAt?: string
  target?: string
  issue?: string
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
  executionThreadId: '',
  codexExecutable: ''
}

export const DEFAULT_FEISHU_STATUS: FeishuStatus = {
  enabled: false,
  phase: 'idle'
}
