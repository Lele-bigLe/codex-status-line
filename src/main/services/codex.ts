import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import os from 'node:os'
import { app } from 'electron'
import { readOfficialCodexCredentials, resolveCodexAuthPath } from './quota'
import type { AutomationAccount, CycleWindow, ResetCredit } from '../../shared/automation'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const string = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const date = (value: unknown): string | undefined => {
  const seconds = number(value)
  if (seconds === undefined || seconds < 0) return undefined
  const ms = seconds * 1000
  return Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : undefined
}

async function findExecutable(): Promise<string> {
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const target =
    process.platform === 'win32'
      ? `${arch}-pc-windows-msvc`
      : process.platform === 'darwin'
        ? `${arch}-apple-darwin`
        : `${arch}-unknown-linux-musl`
  const packageName = `@openai/codex-${process.platform}-${process.arch}`
  const home = os.homedir()
  const directories = new Set(
    (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((value) => value.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
  )
  const nvmRoots = new Set(
    [process.env.NVM_HOME, process.env.NVM_DIR, path.join(home, '.nvm')].filter(
      (value): value is string => Boolean(value)
    )
  )
  for (const value of [
    process.env.NVM_SYMLINK,
    process.env.PNPM_HOME,
    process.env.npm_config_prefix,
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'install', 'global')
  ]) {
    if (value) directories.add(value)
  }
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      directories.add(path.join(process.env.APPDATA, 'npm'))
      nvmRoots.add(path.join(process.env.APPDATA, 'nvm'))
    }
    if (process.env.LOCALAPPDATA) {
      directories.add(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'))
      directories.add(path.join(process.env.LOCALAPPDATA, 'pnpm'))
      nvmRoots.add(path.join(process.env.LOCALAPPDATA, 'nvm'))
    }
    if (process.env.ProgramFiles) directories.add(path.join(process.env.ProgramFiles, 'nodejs'))
  } else {
    for (const value of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) directories.add(value)
  }
  try {
    const prefix = (await fs.readFile(path.join(home, '.npmrc'), 'utf8')).match(
      /^\s*prefix\s*=\s*(.+?)\s*$/m
    )?.[1]
    if (prefix)
      directories.add(
        prefix
          .replace(/^~(?=[/\\]|$)/, home)
          .replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '')
      )
  } catch {
    /* 没有自定义 npm 安装目录。 */
  }

  async function inDirectory(directory: string): Promise<string | undefined> {
    let resolved: string
    try {
      resolved = await fs.realpath(directory)
    } catch {
      return undefined
    }
    if (/^v\d+\.\d+\.\d+/.test(path.basename(resolved))) nvmRoots.add(path.dirname(resolved))
    for (const root of [
      path.join(resolved, 'node_modules'),
      path.join(resolved, '..', 'lib', 'node_modules'),
      path.join(resolved, 'lib', 'node_modules')
    ]) {
      try {
        const require = createRequire(path.join(root, '@openai', 'codex', 'package.json'))
        const packageFile = require.resolve(`${packageName}/package.json`)
        for (const folder of ['bin', 'codex']) {
          const executable = path.join(path.dirname(packageFile), 'vendor', target, folder, binary)
          try {
            if ((await fs.stat(executable)).isFile()) return executable
          } catch {
            /* 检查另一个版本的布局。 */
          }
        }
      } catch {
        /* 此 PATH 项没有 Codex 平台包。 */
      }
      // 较早的 npm 包将原生程序直接放在主包 vendor 中。
      for (const folder of ['bin', 'codex']) {
        const executable = path.join(root, '@openai', 'codex', 'vendor', target, folder, binary)
        try {
          if ((await fs.stat(executable)).isFile()) return executable
        } catch {
          /* 继续查找。 */
        }
      }
    }
    const direct = path.join(resolved, binary)
    try {
      if ((await fs.stat(direct)).isFile()) return direct
    } catch {
      /* 继续查找安装来源。 */
    }
    return undefined
  }
  for (const directory of directories) {
    const found = await inDirectory(directory)
    if (found) return found
  }
  const byVersion = (a: string, b: string): number =>
    b.localeCompare(a, undefined, { numeric: true })
  for (const root of nvmRoots) {
    for (const versionRoot of [root, path.join(root, 'versions', 'node')]) {
      try {
        const versions = (await fs.readdir(versionRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+/.test(entry.name))
          .map((entry) => entry.name)
          .sort(byVersion)
        for (const version of versions) {
          const found =
            (await inDirectory(path.join(versionRoot, version))) ??
            (await inDirectory(path.join(versionRoot, version, 'bin')))
          if (found) return found
        }
      } catch {
        /* 用户未安装 nvm。 */
      }
    }
  }
  const pnpmHome =
    process.env.PNPM_HOME ??
    (process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'pnpm')
      : undefined)
  if (pnpmHome) {
    try {
      for (const entry of await fs.readdir(path.join(pnpmHome, 'global'), {
        withFileTypes: true
      })) {
        if (!entry.isDirectory()) continue
        const found = await inDirectory(path.join(pnpmHome, 'global', entry.name))
        if (found) return found
      }
    } catch {
      /* 没有 pnpm 全局安装。 */
    }
  }
  const extensionTarget = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const root = path.join(home, editor, 'extensions')
    try {
      const extensions = (await fs.readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
        .map((entry) => entry.name)
        .sort(byVersion)
      for (const extension of extensions) {
        const found = await inDirectory(path.join(root, extension, 'bin', extensionTarget))
        if (found) return found
      }
    } catch {
      /* 此编辑器未安装 Codex 扩展。 */
    }
  }
  const applicationResources =
    process.platform === 'darwin'
      ? [
          '/Applications/Codex.app/Contents/Resources',
          '/Applications/ChatGPT.app/Contents/Resources',
          path.join(home, 'Applications', 'Codex.app', 'Contents', 'Resources')
        ]
      : process.platform === 'win32'
        ? [
            process.env.LOCALAPPDATA &&
              path.join(process.env.LOCALAPPDATA, 'Programs', 'Codex', 'resources'),
            process.env.LOCALAPPDATA &&
              path.join(process.env.LOCALAPPDATA, 'Programs', 'ChatGPT', 'resources'),
            process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Codex', 'resources')
          ].filter((value): value is string => Boolean(value))
        : ['/opt/Codex/resources', '/opt/codex/resources']
  for (const resource of applicationResources) {
    const found = (await inDirectory(resource)) ?? (await inDirectory(path.join(resource, 'bin')))
    if (found) return found
  }
  throw new Error(
    '未找到本机 Codex CLI，请安装 Codex CLI 或官方编辑器扩展后刷新 / No local Codex CLI found; install Codex CLI or the official editor extension and refresh'
  )
}

class CodexSession {
  private nextId = 1
  private buffer = ''
  private closed = false
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private listeners = new Set<(method: string, params: Record<string, unknown>) => void>()

  constructor(
    private process: ChildProcessWithoutNullStreams,
    readonly accountId: string
  ) {
    process.stdout.setEncoding('utf8')
    process.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      if (this.buffer.length > 4 * 1024 * 1024) {
        this.close(new Error('Codex 响应过大 / Codex response exceeded the size limit'))
        return
      }
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        try {
          this.receive(JSON.parse(line))
        } catch {
          /* 忽略非协议输出，不把日志或凭据传到界面。 */
        }
      }
    })
    process.stderr.resume()
    process.stdin.on('error', () =>
      this.close(new Error('Codex 连接中断 / Codex connection closed'))
    )
    process.on('error', () =>
      this.close(new Error('无法启动 Codex CLI / Could not start Codex CLI'))
    )
    process.on('exit', () => this.close(new Error('Codex 进程已退出 / Codex process exited')))
  }

  request(method: string, params: Record<string, unknown>, timeout = 20000): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error('Codex 连接已关闭 / Codex connection is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            'Codex 请求超时，结果可能尚未确认 / Codex request timed out; its outcome may be unknown'
          )
        )
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, params })
    })
  }

  private send(message: unknown): void {
    if (!this.closed) this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(value: unknown): void {
    const message = record(value)
    if (!message) return
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        // 内部计时请求不批准工具、登录更新或外部操作。
        this.send({
          id: message.id,
          error: { code: -32601, message: 'Unsupported by the cycle trigger client' }
        })
      } else {
        for (const listener of this.listeners)
          listener(message.method, record(message.params) ?? {})
      }
      return
    }
    const item = this.pending.get(message.id as number)
    if (!item) return
    this.pending.delete(message.id as number)
    clearTimeout(item.timer)
    const error = record(message.error)
    if (error) {
      // 服务错误可能包含请求数据，仅传递固定说明。
      item.reject(
        new Error(
          error.code === -32601
            ? '当前 Codex 版本不支持此接口，请更新 Codex / This Codex version does not support the requested method'
            : 'Codex 拒绝了请求，请检查登录、额度或版本 / Codex rejected the request; check sign-in, limits and version'
        )
      )
    } else item.resolve(message.result)
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'codex_status', title: 'Codex Status', version: app.getVersion() },
      capabilities: { experimentalApi: true }
    })
    this.send({ method: 'initialized', params: {} })
  }

  async trigger(cwd: string, checkCredentials: () => Promise<void>): Promise<void> {
    const configResponse = record(await this.request('config/read', { includeLayers: true, cwd }))
    const layers = Array.isArray(configResponse?.layers) ? configResponse.layers : []
    const servers = new Set<string>()
    for (const layer of [configResponse, ...layers]) {
      for (const name of Object.keys(record(record(record(layer)?.config)?.mcp_servers) ?? {}))
        servers.add(name)
    }
    const config = {
      mcp_servers: Object.fromEntries([...servers].map((name) => [name, { enabled: false }]))
    }
    const response = record(
      await this.request('thread/start', {
        cwd,
        model: 'gpt-6-luna',
        modelProvider: 'openai',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        config,
        serviceName: 'codex-status-cycle-trigger',
        serviceTier: 'default',
        baseInstructions:
          'Reply only OK. Do not use tools, read files, run commands or perform any other action.'
      })
    )
    const thread = record(response?.thread)
    const threadId = string(thread?.id)
    if (!threadId || thread?.ephemeral !== true)
      throw new Error(
        'Codex 未创建临时会话，请更新 Codex / Codex did not create an ephemeral thread'
      )
    await checkCredentials()
    let finish!: () => void
    let fail!: (error: Error) => void
    const completed = new Promise<void>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    const listener = (method: string, params: Record<string, unknown>): void => {
      if (method === 'turn/completed' && params.threadId === threadId) {
        if (record(params.turn)?.status === 'completed') finish()
        else fail(new Error('内部触发请求未完成 / The cycle trigger request did not complete'))
      }
    }
    this.listeners.add(listener)
    const timer = setTimeout(
      () =>
        fail(
          new Error('内部触发请求超时，未自动重发 / Cycle trigger timed out; it was not retried')
        ),
      90000
    )
    // 预先订阅完成通知，避免短请求先完成、后收到 turn/start 响应。
    const closed = (method: string): void => {
      if (method === 'connection/closed')
        fail(
          new Error('触发连接已中断，结果尚未确认 / Trigger connection closed; outcome is unknown')
        )
    }
    this.listeners.add(closed)
    try {
      const started = this.request('turn/start', {
        threadId,
        effort: 'low',
        input: [{ type: 'text', text: 'Only reply OK.' }],
        sandboxPolicy: {
          type: 'readOnly',
          access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [cwd] }
        }
      })
      await Promise.all([started, completed])
    } finally {
      clearTimeout(timer)
      this.listeners.delete(listener)
      this.listeners.delete(closed)
    }
  }

  close(error = new Error('Codex 操作已取消 / Codex operation cancelled')): void {
    if (this.closed) return
    this.closed = true
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
    for (const listener of this.listeners) listener('connection/closed', {})
    this.listeners.clear()
    this.process.kill()
  }
}

export class CodexClient {
  private sessions = new Set<CodexSession>()
  private revision = 0

  cancel(): void {
    this.revision++
    for (const session of this.sessions) session.close()
    this.sessions.clear()
  }

  async withAccount<T>(
    key: string | undefined,
    action: (
      session: CodexSession,
      account: AutomationAccount,
      check: () => Promise<void>
    ) => Promise<T>
  ): Promise<T> {
    const revision = this.revision
    const lookup = await readOfficialCodexCredentials()
    const credentials = lookup.credentials
    if (!credentials) throw new Error(lookup.issue ?? '请先登录 Codex / Sign in to Codex first')
    if (key && key !== credentials.key)
      throw new Error('账号已变化，请重新刷新 / Account changed; refresh first')
    const check = async (): Promise<void> => {
      const latest = (await readOfficialCodexCredentials()).credentials
      if (
        revision !== this.revision ||
        latest?.key !== credentials.key ||
        latest.accessToken !== credentials.accessToken
      ) {
        throw new Error('登录信息已变化，操作已取消 / Sign-in changed; operation cancelled')
      }
    }
    const executable = await findExecutable()
    await check()
    const session = new CodexSession(
      spawn(
        executable,
        [
          'app-server',
          '-c',
          'cli_auth_credentials_store="file"',
          '-c',
          'model_provider="openai"',
          '-c',
          'features.hooks=false',
          '-c',
          'features.codex_hooks=false',
          '-c',
          'features.apps=false',
          '-c',
          'features.shell_tool=false',
          '-c',
          'features.unified_exec=false',
          '-c',
          'features.multi_agent=false',
          '-c',
          'features.browser_use=false',
          '-c',
          'features.computer_use=false',
          '-c',
          'features.code_mode.enabled=false',
          '-c',
          'web_search="disabled"'
        ],
        {
          windowsHide: true,
          env: { ...process.env, CODEX_HOME: path.dirname(resolveCodexAuthPath()) },
          stdio: 'pipe'
        }
      ),
      credentials.accountId
    )
    this.sessions.add(session)
    try {
      await session.initialize()
      const auth = record(await session.request('account/read', { refreshToken: false }))
      if (record(auth?.account)?.type !== 'chatgpt')
        throw new Error('此功能需要 ChatGPT 登录 / ChatGPT sign-in is required')
      const account = await this.read(
        session,
        credentials.key,
        credentials.account.label,
        string(record(auth?.account)?.planType)
      )
      await check()
      return await action(session, account, check)
    } finally {
      this.sessions.delete(session)
      session.close()
    }
  }

  async read(
    session: CodexSession,
    key: string,
    label: string,
    planType?: string
  ): Promise<AutomationAccount> {
    const body = record(await session.request('account/rateLimits/read', {}))
    if (body?.accountId != null && body.accountId !== session.accountId) {
      throw new Error(
        '额度响应账号不一致，操作已取消 / Limit response account mismatch; operation cancelled'
      )
    }
    const bucket = record(record(body?.rateLimitsByLimitId)?.codex) ?? record(body?.rateLimits)
    if (!bucket || (bucket.limitId && bucket.limitId !== 'codex'))
      throw new Error('官方未返回 Codex 额度信息 / Codex limits were not returned')
    const windows: CycleWindow[] = []
    for (const name of ['primary', 'secondary']) {
      const window = record(bucket[name])
      const minutes = number(window?.windowDurationMins)
      const usedPercent = number(window?.usedPercent)
      if (
        bucket[name] != null &&
        (!window ||
          minutes === undefined ||
          minutes <= 0 ||
          usedPercent === undefined ||
          usedPercent < 0 ||
          usedPercent > 100)
      ) {
        throw new Error('官方额度窗口格式无效 / Invalid usage window response')
      }
      if (
        minutes !== undefined &&
        minutes > 0 &&
        usedPercent !== undefined &&
        usedPercent >= 0 &&
        usedPercent <= 100
      ) {
        windows.push({ minutes, usedPercent, resetsAt: date(window?.resetsAt) })
      }
    }
    const reset = record(body?.rateLimitResetCredits)
    const count = number(reset?.availableCount)
    const credits: ResetCredit[] = []
    let validDetails = Array.isArray(reset?.credits)
    if (Array.isArray(reset?.credits))
      for (const value of reset.credits) {
        const row = record(value)
        const id = string(row?.id),
          status = string(row?.status)
        if (!id || !status) {
          validDetails = false
          continue
        }
        const expiresAt = date(row?.expiresAt)
        if (row?.expiresAt != null && !expiresAt) validDetails = false
        if (row?.expiresAt === undefined) validDetails = false
        if (row?.resetType !== 'codexRateLimits') validDetails = false
        credits.push({
          id,
          status,
          title: string(row?.title),
          grantedAt: date(row?.grantedAt),
          expiresAt,
          noExpiry: row?.expiresAt === null
        })
      }
    const availableCount =
      count !== undefined && Number.isInteger(count) && count >= 0 ? count : undefined
    return {
      key,
      label,
      planType: string(bucket.planType) ?? planType,
      windows,
      availableCount,
      credits,
      ordinaryUsageAllowed:
        typeof body?.ordinaryUsageAllowed === 'boolean' ? body.ordinaryUsageAllowed : undefined,
      creditsComplete:
        (availableCount === 0 && credits.length === 0) ||
        (validDetails &&
          availableCount !== undefined &&
          new Set(
            credits.filter((credit) => credit.status === 'available').map((credit) => credit.id)
          ).size === availableCount),
      updatedAt: new Date().toISOString()
    }
  }
}
