import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import type { RateLimitWindowSnapshot, UsageSnapshot } from '../../shared/capsule'

interface RawRateLimit {
  windowMinutes?: number
  usedPercent?: number
  resetsAtMs?: number
  resetsInSeconds?: number
}

interface CredentialLookup {
  credentials?: {
    accessToken: string
    accountId: string
    key: string
    account: NonNullable<UsageSnapshot['account']>
  }
  canRefresh: boolean
  issue?: string
}

const OFFICIAL_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const OFFICIAL_QUOTA_TIMEOUT_MS = 8000
const CACHE_MAX_AGE_MS = 15 * 60 * 1000
let cachedSnapshot: { key: string; snapshot: UsageSnapshot } | undefined

export function clearQuotaCache(): void {
  cachedSnapshot = undefined
}

export async function collectUsageSnapshot(
  initialLookup?: CredentialLookup
): Promise<UsageSnapshot> {
  const lookup = initialLookup ?? (await readOfficialCodexCredentials())
  const credentials = lookup.credentials
  const base: UsageSnapshot = {
    available: false,
    isRefreshing: false,
    canRefresh: true,
    generatedAt: new Date().toISOString(),
    rateLimits: [],
    rateLimitSource: 'none',
    sourceHost: 'chatgpt.com',
    account: credentials?.account,
    authPath: resolveCodexAuthPath(),
    issues: []
  }
  if (!credentials) {
    clearQuotaCache()
    return { ...base, officialIssue: lookup.issue, issues: [lookup.issue ?? '无法识别监测账号'] }
  }
  if (cachedSnapshot?.key !== credentials.key) clearQuotaCache()
  let rateLimits: UsageSnapshot['rateLimits'] | undefined
  let plan: string | undefined
  let issue: string | undefined
  try {
    const response = await requestJson(
      OFFICIAL_CODEX_USAGE_URL,
      buildOfficialHeaders(credentials),
      OFFICIAL_QUOTA_TIMEOUT_MS
    )
    const body = getRecord(response)
    plan = getString(body?.plan_type)
    const responseAccount = getString(body?.account_id ?? body?.accountId)
    if (responseAccount && responseAccount !== credentials.accountId) {
      clearQuotaCache()
      throw new Error('额度响应账号不一致,请重新登录 Codex')
    }
    rateLimits = parseOfficialRateLimits(response, new Date())
    if (rateLimits === undefined) issue = '官方接口未返回有效额度窗口'
  } catch (error) {
    issue = error instanceof Error ? error.message : '官方额度请求失败'
  }
  // 换号清空缓存;同账号续期只丢弃旧令牌的响应,保留此前已确认的数据。
  const latest = await readOfficialCodexCredentials()
  if (latest.credentials?.key !== credentials.key) {
    clearQuotaCache()
    return {
      ...base,
      account: latest.credentials?.account,
      officialIssue: '登录信息已变化,等待重新同步',
      issues: ['登录信息已变化,等待重新同步']
    }
  }
  if (latest.credentials?.accessToken !== credentials.accessToken) {
    rateLimits = undefined
    issue = '登录凭据已更新,等待重新同步'
  }
  const generatedAt = new Date().toISOString()
  if (rateLimits !== undefined) {
    const snapshot: UsageSnapshot = {
      ...base,
      available: rateLimits.length > 0,
      generatedAt,
      lastSuccessAt: generatedAt,
      rateLimits,
      plan,
      rateLimitSource: 'official'
    }
    cachedSnapshot = { key: credentials.key, snapshot }
    return snapshot
  }
  const cached = selectCachedSnapshot(cachedSnapshot, credentials.key)
  return {
    ...base,
    ...(cached
      ? {
          available: cached.available,
          rateLimits: cached.rateLimits,
          plan: cached.plan,
          rateLimitSource: 'cache' as const,
          lastSuccessAt: cached.lastSuccessAt
        }
      : {}),
    generatedAt,
    officialIssue: issue,
    issues: [issue ?? '官方额度暂不可用']
  }
}

export function selectCachedSnapshot(
  cached: { key: string; snapshot: UsageSnapshot } | undefined,
  key: string,
  now = Date.now()
): UsageSnapshot | undefined {
  if (!cached || cached.key !== key || !cached.snapshot.lastSuccessAt) return undefined
  const age = now - Date.parse(cached.snapshot.lastSuccessAt)
  return age >= 0 && age <= CACHE_MAX_AGE_MS ? cached.snapshot : undefined
}

function buildOfficialHeaders(credentials: {
  accessToken: string
  accountId: string
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    'User-Agent': 'codex-cli',
    Accept: 'application/json',
    'Cache-Control': 'no-cache'
  }

  if (credentials.accountId) {
    headers['ChatGPT-Account-Id'] = credentials.accountId
  }

  return headers
}

// null 表示官方明确未返回计时窗口;undefined 表示接口不可用或窗口数据无效。
export function parseOfficialDispatchResetAts(
  response: unknown
): Record<string, number> | null | undefined {
  const body = getRecord(response)
  const rateLimit = getRecord(body?.rate_limit ?? body?.rateLimit)
  if (!rateLimit) {
    return undefined
  }

  const resetAts: Record<string, number> = {}
  for (const [id, windowState] of getOfficialWindowEntries(rateLimit)) {
    const resetAt = getNonNegativeNumber(windowState.reset_at ?? windowState.resetAt)
    if (resetAt === undefined) {
      return undefined
    }
    resetAts[id] = resetAt
  }

  return Object.keys(resetAts).length > 0 ? resetAts : null
}

export function areOfficialDispatchResetAtsStable(
  left: Record<string, number>,
  right: Record<string, number>,
  toleranceSeconds: number
): boolean {
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => right[key] !== undefined && Math.abs(left[key] - right[key]) <= toleranceSeconds
    )
  )
}

// 窗口未激活时,官方接口的 reset_at 恒等于"当前时间 + 窗口全长"并随查询时间漂移;
// 激活后 reset_at 固定不变。调用方据此逐个判断官方实际返回的窗口是否启动计时。
export async function fetchOfficialDispatchResetAts(): Promise<
  Record<string, number> | null | undefined
> {
  const credentialLookup = await readOfficialCodexCredentials()
  if (!credentialLookup.credentials) {
    return undefined
  }

  try {
    const response = await requestJson(
      OFFICIAL_CODEX_USAGE_URL,
      buildOfficialHeaders(credentialLookup.credentials),
      OFFICIAL_QUOTA_TIMEOUT_MS
    )
    return parseOfficialDispatchResetAts(response)
  } catch {
    return undefined
  }
}

export async function readOfficialCodexCredentials(): Promise<CredentialLookup> {
  const authPath = resolveCodexAuthPath()

  try {
    const content = await fs.readFile(authPath, 'utf8')
    return parseCodexCredentials(JSON.parse(content))
  } catch {
    return { canRefresh: true, issue: '无法读取 Codex auth.json,请检查登录状态和凭据路径' }
  }
}

export function parseCodexCredentials(value: unknown): CredentialLookup {
  const auth = getRecord(value)
  const mode = getString(auth?.auth_mode ?? auth?.authMode)
  const tokens = getRecord(auth?.tokens)
  const accessToken = getString(tokens?.access_token ?? tokens?.accessToken)
  if ((mode && mode !== 'chatgpt') || (!mode && getString(auth?.OPENAI_API_KEY))) {
    return { canRefresh: true, issue: '当前不是 ChatGPT 登录,无法监测订阅额度' }
  }
  if (!accessToken) return { canRefresh: true, issue: '缺少 ChatGPT 凭据,请在 Codex 中登录' }
  const claims = decodeClaims(accessToken)
  const idClaims = decodeClaims(getString(tokens?.id_token ?? tokens?.idToken))
  const accessAuth = getRecord(claims?.['https://api.openai.com/auth'])
  const idAuth = getRecord(idClaims?.['https://api.openai.com/auth'])
  const accountId =
    getString(tokens?.account_id ?? tokens?.accountId) ??
    getString(accessAuth?.chatgpt_account_id) ??
    getString(idAuth?.chatgpt_account_id)
  if (!accountId) return { canRefresh: true, issue: '缺少账号标识,请重新登录 Codex 后刷新' }
  const tokenAccountId = getString(accessAuth?.chatgpt_account_id)
  if (tokenAccountId && tokenAccountId !== accountId) {
    return { canRefresh: true, issue: '账号标识与登录令牌不一致,请重新登录 Codex' }
  }
  // JWT 仅用于本地标注和缓存隔离,凭据有效性仍由官方接口鉴权确认。
  const subject =
    getString(accessAuth?.chatgpt_user_id) ??
    getString(claims?.sub) ??
    getString(idAuth?.chatgpt_user_id) ??
    getString(idClaims?.sub) ??
    accessToken
  const profile = getRecord(claims?.['https://api.openai.com/profile'])
  const email = getString(profile?.email) ?? getString(idClaims?.email)
  return {
    canRefresh: true,
    credentials: {
      accessToken,
      accountId,
      key: createHash('sha256')
        .update(JSON.stringify([accountId, subject]))
        .digest('hex'),
      account: {
        label:
          email?.replace(/^(.{1,2})[^@]*(@.*)$/, '$1***$2') ?? `ChatGPT · …${accountId.slice(-6)}`,
        workspace: `…${accountId.slice(-6)}`
      }
    }
  }
}

function decodeClaims(token: string | undefined): Record<string, unknown> | undefined {
  try {
    const payload = token?.split('.')[1]
    return payload
      ? getRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
      : undefined
  } catch {
    return undefined
  }
}

function requestJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(url), { method: 'GET', headers }, (response) => {
      const chunks: Buffer[] = []

      response.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      response.on('error', reject)
      response.on('aborted', () => reject(new Error('官方额度连接中断')))

      response.on('end', () => {
        const statusCode = response.statusCode ?? 0
        const body = Buffer.concat(chunks).toString('utf8')

        if (statusCode === 401 || statusCode === 403) {
          reject(new Error(`登录已失效或无访问权限 HTTP ${statusCode},请在 Codex 中重新登录`))
          return
        }

        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`官方额度接口返回 HTTP ${statusCode}`))
          return
        }

        try {
          resolve(body.trim().length > 0 ? JSON.parse(body) : {})
        } catch {
          reject(new Error('官方额度接口返回内容不是有效 JSON'))
        }
      })
    })

    const timeout = setTimeout(
      () => {
        request.destroy(new Error('官方额度接口请求超时'))
      },
      Math.max(1000, timeoutMs)
    )
    request.on('close', () => clearTimeout(timeout))
    request.on('error', reject)
    request.end()
  })
}

export function parseOfficialRateLimits(
  response: unknown,
  observedAt: Date
): UsageSnapshot['rateLimits'] | undefined {
  const body = getRecord(response)
  const rateLimit = getRecord(body?.rate_limit ?? body?.rateLimit)
  if (!rateLimit) {
    return undefined
  }

  if (
    Object.entries(rateLimit).some(
      ([key, value]) =>
        (key.endsWith('_window') || key.endsWith('Window')) && value != null && !getRecord(value)
    )
  )
    return undefined

  const windows = getOfficialWindowEntries(rateLimit).map(([id, record]) =>
    createOfficialRateLimitWindow(id, record, observedAt)
  )
  if (windows.some((window) => !window)) return undefined
  return (windows as RateLimitWindowSnapshot[]).sort(
    (left, right) =>
      (left.windowMinutes ?? Infinity) - (right.windowMinutes ?? Infinity) ||
      left.id.localeCompare(right.id)
  )
}

function createOfficialRateLimitWindow(
  id: string,
  record: Record<string, unknown> | undefined,
  observedAt: Date
): RateLimitWindowSnapshot | undefined {
  if (!record) {
    return undefined
  }

  const limitWindowSeconds = getNonNegativeNumber(
    record.limit_window_seconds ?? record.limitWindowSeconds
  )
  const usedPercent = getNonNegativeNumber(record.used_percent ?? record.usedPercent)
  const resetsAtMs = normalizeEpochMs(
    record.reset_at ?? record.resetAt ?? record.resets_at ?? record.resetsAt
  )

  if (usedPercent === undefined || usedPercent > 100) {
    return undefined
  }

  return createRateLimitWindow(
    id,
    {
      windowMinutes: limitWindowSeconds !== undefined ? limitWindowSeconds / 60 : undefined,
      usedPercent,
      resetsAtMs,
      resetsInSeconds: getNonNegativeNumber(record.reset_after_seconds ?? record.resetAfterSeconds)
    },
    observedAt
  )
}

export function resolveCodexAuthPath(): string {
  return path.join(resolveCodexConfigDir(), 'auth.json')
}

function resolveCodexConfigDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return codexHome ? path.resolve(expandHome(codexHome)) : path.join(os.homedir(), '.codex')
}

function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir()
  }
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function createRateLimitWindow(
  id: string,
  raw: RawRateLimit,
  snapshotTime: Date
): RateLimitWindowSnapshot {
  const now = snapshotTime.getTime()
  const resetDate =
    raw.resetsAtMs !== undefined
      ? new Date(raw.resetsAtMs)
      : raw.resetsInSeconds !== undefined
        ? new Date(snapshotTime.getTime() + raw.resetsInSeconds * 1000)
        : undefined
  const resetsAt = resetDate && Number.isFinite(resetDate.getTime()) ? resetDate : undefined
  const usedPercent = clampPercent(raw.usedPercent)
  const remainingPercent = usedPercent === undefined ? undefined : clampPercent(100 - usedPercent)
  const resetsInSeconds =
    resetsAt === undefined ? undefined : Math.max(0, Math.floor((resetsAt.getTime() - now) / 1000))

  return {
    id,
    label: resolveWindowLabel(id, raw.windowMinutes),
    windowMinutes: raw.windowMinutes,
    usedPercent,
    remainingPercent,
    resetsAt: resetsAt?.toISOString(),
    resetsInSeconds,
    observedAt: snapshotTime.toISOString()
  }
}

function resolveWindowLabel(id: string, windowMinutes: number | undefined): string {
  if (windowMinutes === undefined) {
    return id
  }
  if (windowMinutes >= 1440) {
    return `${windowMinutes / 1440}d`
  }
  if (windowMinutes >= 60) {
    return `${windowMinutes / 60}h`
  }
  return `${windowMinutes}m`
}

function normalizeEpochMs(value: unknown): number | undefined {
  const raw = getNonNegativeNumber(value)
  if (raw === undefined) {
    return undefined
  }

  const ms = raw >= 1_000_000_000_000 ? raw : raw * 1000
  return Number.isFinite(new Date(ms).getTime()) ? ms : undefined
}

function clampPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined
  }

  return Math.max(0, Math.min(100, value))
}

function getOfficialWindowEntries(
  rateLimit: Record<string, unknown>
): Array<[string, Record<string, unknown>]> {
  const windows = new Map<string, Record<string, unknown>>()
  for (const [key, value] of Object.entries(rateLimit)) {
    const suffix = key.endsWith('_window') ? '_window' : key.endsWith('Window') ? 'Window' : ''
    const windowState = suffix ? getRecord(value) : undefined
    if (windowState) {
      windows.set(key.slice(0, -suffix.length), windowState)
    }
  }
  return Array.from(windows.entries())
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function getNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 ? value : undefined
  }
  if (typeof value === 'string') {
    const parsed = value.trim() ? Number(value) : NaN
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
  }
  return undefined
}
