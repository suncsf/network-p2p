import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import { generateToken, verifyPassword } from './auth'
import { AccountRepo, AuditRepo, SettingsRepo } from './repo'
import { PermissionChecker, FileOps, TransferManager, type TransferServerConfig } from './fs-ops'
import type { TransferStore } from '@main/transfers'
import type { Db } from './db'
import {
  Permission,
  hasPermission,
  resolvePermission,
  type PermissionNode
} from '@shared/permissions'
import type {
  RpcRequest,
  RpcResponse,
  ServerEvent,
  LoginResult,
  FileRootGrant
} from '@shared/protocol'
import { createReceiveServer, sendFiles } from '@main/p2p/transfer'
import net from 'node:net'

export interface ServerConfig {
  wsPort: number
  p2pPort: number
  confirmTimeoutMs: number
  autoAccept: boolean
  lockAfter: number
  lockMs: number
}

export interface AuthSession {
  accountId: number
  username: string
  token: string
  grants: Map<string, { root: string; nodes: PermissionNode[] }>
  socket: WebSocket
  lastSeen: number
}

interface TransferGrantRecord {
  token: string
  accountId: number
  root: string
  relPath: string
  direction: 'send' | 'receive'
  expiresAt: number
  /** 本机用户主动发起的下载：发起时已选好保存位置，接收端免二次确认 */
  preAuthorized?: boolean
}

export class LatticeServer {
  private wss?: WebSocketServer
  private http?: Server
  private p2pServer?: net.Server
  private sessions = new Map<string, AuthSession>()
  private transferGrants = new Map<string, TransferGrantRecord>()
  /** 进行中的 P2P 推送任务（sessionId → 任务），支持取消 */
  private pushJobs = new Map<string, { aborted: boolean }>()
  /** 发送端进度节流（sessionId → 上次百分比） */
  private pushPct = new Map<string, number>()
  /** 接收中的 socket（sessionId → socket），支持接收端主动中止 */
  private recvSockets = new Map<string, net.Socket>()
  private accounts: AccountRepo
  private audit: AuditRepo
  private settings: SettingsRepo
  private transfers: TransferManager
  private running = false
  /** 本机 UI 事件钩子：服务端内部事件（如远端发起的下载待确认）转发给本机渲染层 */
  onLocalEvent?: (ev: ServerEvent) => void

  constructor(
    private db: Db,
    private config: ServerConfig,
    /** 传输记录存储（可选；测试环境可不传） */
    private store?: TransferStore
  ) {
    this.accounts = new AccountRepo(db)
    this.audit = new AuditRepo(db)
    this.settings = new SettingsRepo(db)
    this.transfers = new TransferManager(
      { p2pPort: config.p2pPort, confirmTimeoutMs: config.confirmTimeoutMs, autoAccept: config.autoAccept },
      (ev) => {
        this.broadcast(ev)
        this.onLocalEvent?.(ev)
      }
    )
  }

  get accountRepo(): AccountRepo {
    return this.accounts
  }
  get auditRepo(): AuditRepo {
    return this.audit
  }
  get transferManager(): TransferManager {
    return this.transfers
  }

  isRunning(): boolean {
    return this.running
  }

  updateConfig(patch: Partial<ServerConfig>): void {
    this.config = { ...this.config, ...patch }
    // 热更新运行中的接收端配置：自动接收/确认超时立即生效；端口需重启服务端重新绑定
    this.transfers.update({
      p2pPort: this.config.p2pPort,
      confirmTimeoutMs: this.config.confirmTimeoutMs,
      autoAccept: this.config.autoAccept
    })
  }

  /** 端口预检：返回是否有端口被占用 */
  static checkPort(port: number, host = '0.0.0.0'): Promise<boolean> {
    return new Promise((resolve) => {
      const tester = net.createServer()
      tester.once('error', () => resolve(false))
      tester.once('listening', () => tester.close(() => resolve(true)))
      tester.listen(port, host)
    })
  }

  async start(): Promise<void> {
    if (this.running) return
    this.http = createServer()
    this.wss = new WebSocketServer({ server: this.http })
    this.wss.on('connection', (socket) => this.onConnection(socket))

    const recvPct = new Map<string, number>()
    const p2p = createReceiveServer({
      baseDir: '',
      // 根据 transfer grant 动态解析接收根目录，确保写入限制在授权目录内
      resolveBaseDir: (sessionId) => {
        const g = this.transferGrants.get(sessionId)
        return g?.root
      },
      validateToken: (token) => {
        const g = this.transferGrants.get(token)
        if (g && g.expiresAt > Date.now()) {
          // 滑动续期：每次成功握手延长授权，长传输/续传不受初始 5 分钟限制
          g.expiresAt = Date.now() + 5 * 60 * 1000
        }
        return !!g && g.expiresAt > Date.now()
      },
      requestConfirm: async (info) => {
        const g = this.transferGrants.get(info.sessionId)
        if (!g) return false
        const rec = this.store?.getBySession(info.sessionId).find((r) => r.kind === 'p2p-recv')
        // 本机用户主动发起的下载：发起时已选好保存位置，直接放行（确认权在对端服务端）
        if (g.preAuthorized) {
          if (rec) this.store?.update(rec.id, { total: info.totalSize })
          return true
        }
        // 断点续传：同会话记录存在且非进行中 → 沿用既有授权，免二次确认
        if (info.resume && rec && (rec.state === 'interrupted' || rec.state === 'cancelled')) {
          this.store?.update(rec.id, { state: 'active', error: null, total: info.totalSize })
          return true
        }
        const from = g.accountId > 0 ? this.sessionUsername(g.accountId) : 'P2P 对端'
        const ok = await this.transfers.request({
          sessionId: info.sessionId,
          from,
          fileName: info.fileName,
          fileCount: info.fileCount,
          totalSize: info.totalSize
        })
        if (rec) {
          if (ok) this.store?.update(rec.id, { total: info.totalSize })
          else this.store?.update(rec.id, { state: 'cancelled', error: '已拒绝或确认超时' })
        } else if (!ok) {
          this.broadcast({ event: 'transfer:progress', data: { sessionId: info.sessionId, cancelled: true } })
        }
        return ok
      },
      // 注册接收 socket，支持「接收端取消」
      onSocket: (sessionId, socket) => {
        this.recvSockets.set(sessionId, socket)
        socket.on('close', () => {
          if (this.recvSockets.get(sessionId) === socket) this.recvSockets.delete(sessionId)
        })
      },
      // 接收端视角的进度广播 + 记录更新
      onProgress: (received, total, sessionId) => {
        const rec = this.store?.getBySession(sessionId).find((r) => r.kind === 'p2p-recv')
        if (rec && rec.state === 'active') this.store?.updateProgress(rec.id, received, total)
        const pct = total > 0 ? received / total : 1
        const last = recvPct.get(sessionId) ?? -1
        if (pct === 1 || pct - last >= 0.05) {
          recvPct.set(sessionId, pct)
          this.broadcast({ event: 'transfer:progress', data: { sessionId, sent: received, total } })
        }
      },
      onDone: (sessionId) => {
        const rec = this.store?.getBySession(sessionId).find((r) => r.kind === 'p2p-recv')
        if (rec && rec.state === 'active') this.store?.update(rec.id, { state: 'completed', error: null })
        recvPct.delete(sessionId)
        this.recvSockets.delete(sessionId)
        this.broadcast({ event: 'transfer:progress', data: { sessionId, done: true } })
      },
      // 完成前连接断开：记录标记为已中断（部分文件保留，可断点续传）
      onInterrupted: (sessionId, received) => {
        const rec = this.store?.getBySession(sessionId).find((r) => r.kind === 'p2p-recv')
        if (rec && rec.state === 'active') {
          this.store?.update(rec.id, { state: 'interrupted', transferred: received, error: '连接中断' })
        }
        this.broadcast({ event: 'transfer:progress', data: { sessionId, failed: true, reason: '连接中断' } })
      }
    })
    this.p2pServer = p2p

    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject)
      this.http!.listen(this.config.wsPort, '0.0.0.0', () => resolve())
    })
    await new Promise<void>((resolve, reject) => {
      this.p2pServer!.once('error', reject)
      this.p2pServer!.listen(this.config.p2pPort, '0.0.0.0', () => resolve())
    })

    this.running = true
    this.audit.log(null, 'server:start', { wsPort: this.config.wsPort, p2pPort: this.config.p2pPort })
  }

  async stop(): Promise<void> {
    if (!this.running) return
    for (const j of this.pushJobs.values()) j.aborted = true
    this.pushJobs.clear()
    for (const s of this.recvSockets.values()) s.destroy()
    this.recvSockets.clear()
    for (const s of this.sessions.values()) s.socket.close()
    this.sessions.clear()
    await new Promise<void>((r) => this.wss?.close(() => r()))
    await new Promise<void>((r) => this.http?.close(() => r()))
    await new Promise<void>((r) => this.p2pServer?.close(() => r()))
    this.running = false
    this.audit.log(null, 'server:stop')
  }

  listInterfaces(): string[] {
    const out: string[] = []
    const ifaces = networkInterfaces()
    for (const name of Object.keys(ifaces)) {
      for (const i of ifaces[name] ?? []) {
        if (i.family === 'IPv4' && !i.internal) out.push(i.address)
      }
    }
    return out
  }

  private onConnection(socket: WebSocket): void {
    let session: AuthSession | null = null

    socket.on('message', async (raw) => {
      let req: RpcRequest
      try {
        req = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      if (req.method === 'login') {
        const result = await this.handleLogin(socket, req)
        if (result) session = result
        return
      }

      const token = (req.params as { token?: string } | undefined)?.token
      const s = token ? this.sessions.get(token) : undefined
      if (!s || s.socket !== socket) {
        this.reply(socket, req.id, false, undefined, { code: 'UNAUTHORIZED', message: '未登录或会话已失效' })
        return
      }
      s.lastSeen = Date.now()
      session = s
      await this.dispatch(s, socket, req)
    })

    socket.on('close', () => {
      if (session) {
        this.sessions.delete(session.token)
        this.audit.log(session.username, 'disconnect', {})
      }
    })
  }

  private async handleLogin(socket: WebSocket, req: RpcRequest): Promise<AuthSession | null> {
    const { username, password } = (req.params ?? {}) as { username: string; password: string }
    const acc = this.accounts.findByName(username)
    if (!acc) {
      this.reply(socket, req.id, false, undefined, { code: 'UNAUTHORIZED', message: '账号或密码错误' })
      this.audit.log(username, 'login:fail', { reason: 'no-such-account' })
      return null
    }
    if (acc.enabled !== 1) {
      this.reply(socket, req.id, false, undefined, { code: 'FORBIDDEN', message: '账户已被禁用' })
      return null
    }
    if (acc.locked_until > Date.now()) {
      this.reply(socket, req.id, false, undefined, { code: 'LOCKED', message: '账户已锁定，请稍后再试' })
      return null
    }
    if (!verifyPassword(password, acc.password_salt, acc.password_hash)) {
      this.accounts.recordFailure(acc.id, this.config.lockAfter, this.config.lockMs)
      this.reply(socket, req.id, false, undefined, { code: 'UNAUTHORIZED', message: '账号或密码错误' })
      this.audit.log(username, 'login:fail', { reason: 'bad-password' })
      return null
    }
    this.accounts.clearFailures(acc.id)
    const token = generateToken()
    const grants = new Map<string, { root: string; nodes: PermissionNode[] }>()
    for (const g of this.accounts.listGrants(acc.id)) {
      grants.set(g.root_path, { root: g.root_path, nodes: this.accounts.getNodes(g.id) })
    }
    const session: AuthSession = {
      accountId: acc.id,
      username: acc.username,
      token,
      grants,
      socket,
      lastSeen: Date.now()
    }
    this.sessions.set(token, session)
    const protoGrants: FileRootGrant[] = Array.from(grants.entries()).map(([root, v]) => ({
      root,
      label: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
      nodes: v.nodes
    }))
    const result: LoginResult = {
      token,
      username: acc.username,
      protocolVersion: 1,
      grants: protoGrants
    }
    this.reply(socket, req.id, true, result)
    this.audit.log(acc.username, 'login:ok', {})
    // 通知本机 UI：有客户端连上了服务端
    this.onLocalEvent?.({
      event: 'client:login',
      data: { username: acc.username, address: this.remoteAddress(socket) }
    })
    return session
  }

  /** 客户端来源地址（去掉 IPv6 映射前缀 ::ffff:） */
  private remoteAddress(socket: WebSocket): string {
    const addr = (socket as unknown as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? ''
    return addr.replace(/^::ffff:/, '') || '未知地址'
  }

  private checker(s: AuthSession): PermissionChecker {
    return new PermissionChecker(s.grants)
  }

  private async dispatch(s: AuthSession, socket: WebSocket, req: RpcRequest): Promise<void> {
    const ops = new FileOps(this.checker(s))
    const p = req.params as any
    try {
      switch (req.method) {
        case 'list': {
          const entries = await ops.list(p.root, p.path ?? '')
          this.reply(socket, req.id, true, { entries })
          break
        }
        case 'stat': {
          const entry = await ops.stat(p.root, p.path)
          this.reply(socket, req.id, true, { entry })
          break
        }
        case 'mkdir':
          await ops.mkdir(p.root, p.path)
          this.audit.log(s.username, 'mkdir', p)
          this.reply(socket, req.id, true, {})
          break
        case 'rename':
          await ops.rename(p.root, p.path, p.newName)
          this.audit.log(s.username, 'rename', p)
          this.reply(socket, req.id, true, {})
          break
        case 'delete':
          await ops.remove(p.root, p.path, !!p.recursive)
          this.audit.log(s.username, 'delete', p)
          this.reply(socket, req.id, true, {})
          break
        case 'readFile': {
          const r = await ops.readFile(p.root, p.path)
          this.reply(socket, req.id, true, r)
          break
        }
        case 'writeFile':
          await ops.writeFile(p.root, p.path, p.data)
          this.audit.log(s.username, 'writeFile', { root: p.root, path: p.path })
          this.reply(socket, req.id, true, {})
          break
        case 'uploadInit': {
          const r = await ops.createUpload(p.root, p.path)
          this.reply(socket, req.id, true, r)
          break
        }
        case 'uploadChunk':
          await ops.appendUpload(p.uploadId, p.offset, p.data)
          this.reply(socket, req.id, true, {})
          break
        case 'uploadFinish':
          await ops.finishUpload(p.uploadId)
          this.audit.log(s.username, 'upload', { root: p.root, path: p.path })
          this.reply(socket, req.id, true, {})
          break
        case 'transferGrant':
          await this.handleTransferGrant(s, socket, req)
          break
        case 'p2pPush':
          await this.handleP2pPush(s, socket, req, ops)
          break
        case 'p2pPushStop': {
          // 接收方取消：中止本机推送任务并把发送记录标记为已取消
          const sid = (req.params as { sessionId: string }).sessionId
          const job = this.pushJobs.get(sid)
          if (job) job.aborted = true
          for (const r of this.store?.getBySession(sid) ?? []) {
            if (r.kind === 'p2p-send' && (r.state === 'active' || r.state === 'interrupted')) {
              this.store?.update(r.id, { state: 'cancelled', error: '接收方取消了传输' })
            }
          }
          this.reply(socket, req.id, true, {})
          break
        }
        case 'uploadAbort':
          await ops.abortUpload((req.params as { uploadId: string }).uploadId)
          this.reply(socket, req.id, true, {})
          break
        case 'transferDecision':
          this.handleDecision(s, socket, req)
          break
        case 'getPendingTransfers':
          this.reply(socket, req.id, true, { items: this.transfers.listPending() })
          break
        case 'disconnect':
          this.sessions.delete(s.token)
          socket.close()
          break
        default:
          this.reply(socket, req.id, false, undefined, { code: 'BAD_REQUEST', message: `未知方法 ${req.method}` })
      }
    } catch (err) {
      const e = err as { code?: string; message?: string; name?: string }
      let code = (e.code as any) ?? 'INTERNAL'
      if (e.name === 'PathViolationError' || code === 'ENOENT_VIOLATION') code = 'PATH_VIOLATION'
      // 把 Node 的 errno 归一化
      if (code.startsWith('E') && code !== 'EPERM') {
        if (code === 'ERR_BAD_REQUEST') code = 'BAD_REQUEST'
      }
      if (code === 'ENOENT') code = 'NOT_FOUND'
      this.reply(socket, req.id, false, undefined, {
        code,
        message: e.message ?? '内部错误'
      })
    }
  }

  private async handleTransferGrant(s: AuthSession, socket: WebSocket, req: RpcRequest): Promise<void> {
    const p = req.params as { root: string; path: string; direction: 'send' | 'receive' }
    const g = s.grants.get(p.root)
    if (!g) throw Object.assign(new Error('未知根目录'), { code: 'FORBIDDEN' })
    const mask = resolvePermission(g.nodes, p.path)
    const base = p.direction === 'send' ? Permission.DOWNLOAD : Permission.UPLOAD
    if (!hasPermission(mask, Permission.TRANSFER) || !hasPermission(mask, base)) {
      throw Object.assign(new Error('无传输权限'), { code: 'FORBIDDEN' })
    }
    const token = generateToken()
    this.transferGrants.set(token, {
      token,
      accountId: s.accountId,
      root: p.root,
      relPath: p.path,
      direction: p.direction,
      expiresAt: Date.now() + 5 * 60 * 1000
    })
    const host = this.listInterfaces()[0] ?? '127.0.0.1'
    this.reply(socket, req.id, true, {
      p2pToken: token,
      host,
      port: this.config.p2pPort,
      sessionId: token
    })
    this.audit.log(s.username, 'transfer:grant', { root: p.root, path: p.path, direction: p.direction })
  }

  private handleDecision(s: AuthSession, socket: WebSocket, req: RpcRequest): void {
    const p = req.params as { sessionId: string; accept: boolean }
    const ok = this.transfers.decide(p.sessionId, p.accept)
    this.reply(socket, req.id, true, { decided: ok })
  }

  /** 本机接收授权：为 P2P 拉取创建一次性 token（接收端为本机服务端，写入目录由调用方指定） */
  createLocalTransferGrant(
    root: string,
    opts?: { token?: string }
  ): { p2pToken: string; host: string; port: number; sessionId: string } {
    const token = opts?.token ?? generateToken()
    this.transferGrants.set(token, {
      token,
      accountId: 0,
      root,
      relPath: '',
      direction: 'receive',
      expiresAt: Date.now() + 5 * 60 * 1000,
      preAuthorized: true
    })
    const host = this.listInterfaces()[0] ?? '127.0.0.1'
    return { p2pToken: token, host, port: this.config.p2pPort, sessionId: token }
  }

  /** 续传用的最小授权（仅 TRANSFER+DOWNLOAD）：重放先前已授权过的路径 */
  private systemChecker(root: string): PermissionChecker {
    return new PermissionChecker(
      new Map([
        [
          root,
          {
            root,
            nodes: [
              {
                path: '.',
                inherit: false,
                mask: Permission.TRANSFER | Permission.DOWNLOAD | Permission.READ
              }
            ]
          }
        ]
      ])
    )
  }

  /** P2P 推送（或续传）准备阶段：校验权限、收集文件、建立/复用记录 */
  private async preparePush(
    p: {
      root: string
      path: string
      host: string
      port: number
      sessionId: string
      rename?: string
      peer?: string
    },
    ops?: FileOps
  ): Promise<{ recId?: number; fileCount: number; total: number }> {
    const fileOps = ops ?? new FileOps(this.systemChecker(p.root))
    const items = await fileOps.collectForTransfer(p.root, p.path)
    if (items.length === 0) {
      throw Object.assign(new Error('没有可发送的文件'), { code: 'BAD_REQUEST' as const })
    }
    let relPaths: string[] = items.map((f) => f.relPath)
    if (p.rename) {
      if (items.length !== 1 || /[\\/]/.test(p.rename) || p.rename === '.' || p.rename === '..') {
        throw Object.assign(new Error('非法目标文件名'), { code: 'BAD_REQUEST' as const })
      }
      relPaths = [p.rename]
    }
    // 统计总大小（记录展示用）
    let total = 0
    for (const f of items) {
      try {
        total += (await stat(f.absPath)).size
      } catch {
        /* 忽略瞬时不可统计的文件 */
      }
    }
    // 同会话已有发送记录则复用（续传），否则新建
    const existing = this.store?.getBySession(p.sessionId).find((r) => r.kind === 'p2p-send')
    let recId: number | undefined
    if (existing && existing.state !== 'completed') {
      // 仅当确有活跃推送任务时才算冲突；「已标记 active 但任务不在」是续传流程预置的状态，放行
      if (existing.state === 'active' && this.pushJobs.has(p.sessionId)) {
        throw Object.assign(new Error('该传输正在进行中'), { code: 'CONFLICT' as const })
      }
      this.store?.update(existing.id, { state: 'active', error: null, transferred: 0, total })
      recId = existing.id
    } else if (this.store) {
      const rec = this.store.create({
        kind: 'p2p-send',
        peer: p.peer ?? `${p.host}:${p.port}`,
        name: p.rename ? p.rename : basename(p.path) || '传输',
        remotePath: p.path,
        localPath: '',
        total,
        state: 'active',
        sessionId: p.sessionId,
        resume: JSON.stringify({
          root: p.root,
          path: p.path,
          host: p.host,
          port: p.port,
          sessionId: p.sessionId,
          rename: p.rename,
          peer: p.peer
        })
      })
      recId = rec.id
    }
    return { recId, fileCount: items.length, total }
  }

  /** P2P 推送执行阶段：建立任务注册表并发送（数据不经 WS 命令通道） */
  private async executePush(
    p: {
      root: string
      path: string
      host: string
      port: number
      sessionId: string
      p2pToken: string
      rename?: string
      resume?: boolean
      username: string
    },
    ctx: { recId?: number; items: Array<{ absPath: string; relPath: string }>; total: number }
  ): Promise<void> {
    const job = { aborted: false }
    this.pushJobs.set(p.sessionId, job)
    let sentBytes = 0
    let lastStore = 0
    try {
      await sendFiles({
        host: p.host,
        port: Number(p.port),
        token: p.p2pToken,
        sessionId: p.sessionId,
        resume: p.resume === true,
        shouldAbort: () => job.aborted,
        files: ctx.items.map((f, i) => ({ id: i + 1, absPath: f.absPath, relPath: f.relPath })),
        onProgress: (sent, total) => {
          sentBytes = sent
          if (ctx.recId !== undefined) {
            const now = Date.now()
            if (now - lastStore > 300 || sent === total) {
              lastStore = now
              this.store?.updateProgress(ctx.recId, sent, total)
            }
          }
          const pct = total > 0 ? sent / total : 1
          this.pushPct.set(p.sessionId, pct)
          this.broadcast({ event: 'transfer:progress', data: { sessionId: p.sessionId, sent, total } })
        }
      })
      this.pushPct.delete(p.sessionId)
      if (ctx.recId !== undefined) {
        this.store?.update(ctx.recId, { state: 'completed', transferred: ctx.total, error: null })
      }
      this.broadcast({ event: 'transfer:progress', data: { sessionId: p.sessionId, done: true } })
      this.audit.log(p.username, 'p2p:push:done', { root: p.root, path: p.path })
    } catch (e) {
      this.pushPct.delete(p.sessionId)
      const msg = (e as Error).message
      if (!job.aborted) {
        // 未发出任何字节（拒绝/超时/连不上）→ 已取消；中途失败 → 已中断（可续传）
        const state = sentBytes > 0 ? 'interrupted' : 'cancelled'
        if (ctx.recId !== undefined) {
          this.store?.update(ctx.recId, { state, error: msg })
        }
        this.broadcast({
          event: 'transfer:progress',
          data: { sessionId: p.sessionId, ...(state === 'cancelled' ? { cancelled: true } : { failed: true }), reason: msg }
        })
      }
      this.audit.log(p.username, 'p2p:push:fail', { root: p.root, path: p.path, error: msg })
      throw e
    } finally {
      this.pushJobs.delete(p.sessionId)
    }
  }

  /** 取消发送端推送任务（发送面板「取消」） */
  cancelPush(sessionId: string, reason: string): void {
    const job = this.pushJobs.get(sessionId)
    if (job) job.aborted = true
    for (const r of this.store?.getBySession(sessionId) ?? []) {
      if (r.kind === 'p2p-send' && (r.state === 'active' || r.state === 'interrupted')) {
        this.store?.update(r.id, { state: 'cancelled', error: reason })
      }
    }
  }

  /** 接收端主动中止：断开该会话的接收 socket（发送端会感知失败） */
  abortReceive(sessionId: string): void {
    const s = this.recvSockets.get(sessionId)
    if (s) s.destroy()
  }

  /** 续传发送端推送（记录里的 resume 上下文） */
  async resumePush(r: {
    root: string
    path: string
    host: string
    port: number
    sessionId: string
    rename?: string
    peer?: string
  }): Promise<void> {
    const fileOps = new FileOps(this.systemChecker(r.root))
    const prepared = await this.preparePush({ ...r }, fileOps)
    const items = await fileOps.collectForTransfer(r.root, r.path)
    let relPaths: string[] = items.map((f) => f.relPath)
    if (r.rename) relPaths = [r.rename]
    await this.executePush(
      {
        root: r.root,
        path: r.path,
        host: r.host,
        port: r.port,
        sessionId: r.sessionId,
        p2pToken: r.sessionId,
        rename: r.rename,
        resume: true,
        username: 'resume'
      },
      { recId: prepared.recId, items: items.map((f, i) => ({ absPath: f.absPath, relPath: relPaths[i] })), total: prepared.total }
    )
  }

  /** P2P 推送：服务端直接从磁盘分块推流给对端接收端口，不经 WS 命令通道，无大小限制 */
  private async handleP2pPush(
    s: AuthSession,
    socket: WebSocket,
    req: RpcRequest,
    ops: FileOps
  ): Promise<void> {
    const p = req.params as {
      root: string
      path: string
      host: string
      port: number
      p2pToken: string
      sessionId: string
      rename?: string
      resume?: boolean
    }
    const prepared = await this.preparePush(
      { root: p.root, path: p.path, host: p.host, port: Number(p.port), sessionId: p.sessionId, rename: p.rename },
      ops
    )
    this.reply(socket, req.id, true, { fileCount: prepared.fileCount })
    this.audit.log(s.username, 'p2p:push', {
      root: p.root,
      path: p.path,
      files: prepared.fileCount,
      to: `${p.host}:${p.port}`
    })
    const items = await ops.collectForTransfer(p.root, p.path)
    let relPaths: string[] = items.map((f) => f.relPath)
    if (p.rename) relPaths = [p.rename]
    // 异步执行：下载由对端发起，需本机服务端确认后才推送（接收端是发起方本机，已免确认）
    void (async () => {
      // 断点续传：同会话已有发送记录 → 沿用既有授权，免二次确认
      const isResume = p.resume === true && prepared.recId !== undefined
      if (!isResume) {
        const ok = await this.transfers.request({
          sessionId: p.sessionId,
          from: s.username,
          fileName: p.rename ?? basename(p.path),
          fileCount: prepared.fileCount,
          totalSize: prepared.total
        })
        if (!ok) {
          if (prepared.recId !== undefined) {
            this.store?.update(prepared.recId, { state: 'cancelled', error: '已拒绝或确认超时' })
          }
          this.broadcast({
            event: 'transfer:progress',
            data: { sessionId: p.sessionId, cancelled: true, reason: '对方拒绝或确认超时' }
          })
          this.audit.log(s.username, 'p2p:push:fail', { root: p.root, path: p.path, error: '已拒绝或确认超时' })
          return
        }
      }
      await this.executePush(
        {
          root: p.root,
          path: p.path,
          host: p.host,
          port: Number(p.port),
          sessionId: p.sessionId,
          p2pToken: p.p2pToken,
          rename: p.rename,
          resume: p.resume === true,
          username: s.username
        },
        {
          recId: prepared.recId,
          items: items.map((f, i) => ({ absPath: f.absPath, relPath: relPaths[i] })),
          total: prepared.total
        }
      )
    })().catch(() => {
      /* 状态已在 executePush 内落库并广播 */
    })
  }

  private findGrantBySession(sessionId: string): TransferGrantRecord | undefined {
    const g = this.transferGrants.get(sessionId)
    return g
  }

  private sessionUsername(accountId: number): string {
    return this.accounts.findById(accountId)?.username ?? 'unknown'
  }

  private reply(socket: WebSocket, id: number, ok: boolean, result?: unknown, error?: { code: any; message: string }): void {
    if (socket.readyState !== WebSocket.OPEN) return
    const resp: RpcResponse = ok ? { id, ok, result } : { id, ok, error }
    socket.send(JSON.stringify(resp))
  }

  broadcast(ev: ServerEvent): void {
    const msg = JSON.stringify(ev)
    for (const s of this.sessions.values()) {
      if (s.socket.readyState === WebSocket.OPEN) s.socket.send(msg)
    }
  }
}
