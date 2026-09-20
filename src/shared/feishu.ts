export interface FeishuSettings {
  enabled: boolean
  webhook: string
  secret: string
}

export interface FeishuStatus {
  enabled: boolean
  phase: 'idle' | 'sending' | 'sent' | 'failed'
  updatedAt?: string
  issue?: string
}

export const DEFAULT_FEISHU_SETTINGS: FeishuSettings = {
  enabled: false,
  webhook: '',
  secret: ''
}

export const DEFAULT_FEISHU_STATUS: FeishuStatus = {
  enabled: false,
  phase: 'idle'
}
