import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server } from 'node:http'
import { hostname, networkInterfaces } from 'node:os'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
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
  FileRootGrant,
  TransferGrantParams
} from '@shared/protocol'
import { PROTOCOL_VERSION } from '@shared/protocol'
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
  /** 登录时间（epoch ms） */
  loginAt: number
  lastSeen: number
}

interface TransferGrantRecord {
  token: string
  accountId: number
  root: string
  relPath: string
  direction: 'send' | 'receive'
  expiresAt: number
  /** 本机用户主动发起的下载：发起时已选好保存位置，下载端免二次确认 */
  preAuthorized?: boolean
}

/** P2P 传输授权有效期：需覆盖「对端枚举大文件夹 + 人工确认 + 连接建立」等握手前耗时，握手成功后滑动续期 */
const GRANT_TTL_MS = 30 * 60 * 1000

export class LatticeServer {
  private wss?: WebSocketServer
  private http?: Server
  private p2pServer?: net.Server
  private sessions = new Map<string, AuthSession>()
  private transferGrants = new Map<string, TransferGrantRecord>()
  /** WS 下载（对方发起）已确认缓存：key 为 accountId:root:path，值为止步时间；5 分钟内重试/重初始化免二次确认 */
  private wsUploadApproved = new Map<string, number>()
  /** 进行中的 P2P 上传任务（sessionId → 任务），支持取消 */
  private pushJobs = new Map<string, { aborted: boolean; paused?: boolean }>()
  /** 上传端进度节流（sessionId → 上次百分比） */
  private pushPct = new Map<string, number>()
  /** 下载中的 socket（sessionId → socket），支持下载端主动中止 */
  private recvSockets = new Map<string, net.Socket>()
  /** WS 下载（对方发起）进度回写映射：uploadId → 传输记录 id */
  private uploadRecs = new Map<string, number>()
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
    // 热更新运行中的下载端配置：自动下载/确认超时立即生效；端口需重启服务端重新绑定
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
    this.http = createServer((_req, res) => {
      // IP 段检测：探测端发来的 HTTP 请求（非 WS 升级）返回确认数据，
      // 探测端据此判定「该 IP + 默认端口可连接」（见 src/main/net-probe.ts）
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          service: 'v-lattice',
          hostname: hostname(),
          protocolVersion: PROTOCOL_VERSION
        })
      )
    })
    this.wss = new WebSocketServer({ server: this.http })
    this.wss.on('connection', (socket) => this.onConnection(socket))

    const recvPct = new Map<string, number>()
    const p2p = createReceiveServer({
      baseDir: '',
      // 根据 transfer grant 动态解析下载根目录，确保写入限制在授权目录内
      resolveBaseDir: (sessionId) => {
        const g = this.transferGrants.get(sessionId)
        return g?.root
      },
      validateToken: (token, resume) => {
        const g = this.transferGrants.get(token)
        if (g && g.expiresAt > Date.now()) {
          // 滑动续期：每次成功握手延长授权，长传输/续传不受初始限制
          g.expiresAt = Date.now() + GRANT_TTL_MS
          return true
        }
        // 续传兜底：上传端单方面点续传时，下载端授权可能已过期。
        // 同会话下载记录存在且未完成 → 从记录上下文自动重建授权（一次性 token 本身即凭证）
        if (resume) {
          const rec = this.store?.getBySession(token).find((r) => r.kind === 'p2p-recv')
          if (rec && rec.state !== 'completed') {
            try {
              const ctx = JSON.parse(this.store?.getResume(rec.id) ?? '{}') as { dir?: string }
              if (ctx.dir) {
                this.createLocalTransferGrant(ctx.dir, { token })
                this.store?.update(rec.id, { state: 'active', error: null })
                this.audit.log(null, 'transfer:auto-resume-grant', { sessionId: token })
                return true
              }
            } catch {
              /* ignore */
            }
          }
        }
        return false
      },
      requestConfirm: async (info) => {
        const g = this.transferGrants.get(info.sessionId)
        if (!g) return false
        const rec = this.store?.getBySession(info.sessionId).find((r) => r.kind === 'p2p-recv')
        const from = g.accountId > 0 ? this.sessionUsername(g.accountId) : 'P2P 对端'
        // 授权时已确认过（本机发起的下载 / transferGrant 下载方向）：直接放行
        if (g.preAuthorized) {
          if (rec) this.store?.update(rec.id, { total: info.totalSize })
          else this.createRecvRecord(g, from, info)
          return true
        }
        // 断点续传：同会话记录存在且非进行中 → 沿用既有授权，免二次确认（含已暂停）
        if (
          info.resume &&
          rec &&
          (rec.state === 'interrupted' || rec.state === 'cancelled' || rec.state === 'paused')
        ) {
          this.store?.update(rec.id, { state: 'active', error: null, total: info.totalSize })
          return true
        }
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
        } else if (ok) {
          this.createRecvRecord(g, from, info)
        } else {
          this.broadcast({ event: 'transfer:progress', data: { sessionId: info.sessionId, cancelled: true } })
        }
        return ok
      },
      // 注册下载 socket，支持「下载端取消」
      onSocket: (sessionId, socket) => {
        this.recvSockets.set(sessionId, socket)
        socket.on('close', () => {
          if (this.recvSockets.get(sessionId) === socket) this.recvSockets.delete(sessionId)
        })
      },
      // 下载端视角的进度广播 + 记录更新
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

  /** 当前登录的连接列表（服务端「当前连接」页签展示用） */
  listSessions(): Array<{ username: string; address: string; loginAt: number; lastSeen: number }> {
    return Array.from(this.sessions.values()).map((s) => ({
      username: s.username,
      address: this.remoteAddress(s.socket),
      loginAt: s.loginAt,
      lastSeen: s.lastSeen
    }))
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
      // delete 返回 false 说明会话已被移除（server.stop 清空 / disconnect RPC 主动断开），不重复通知
      if (session && this.sessions.delete(session.token)) {
        this.audit.log(session.username, 'disconnect', {})
        // 通知本机 UI：连接已断开（当前连接列表实时刷新）
        this.onLocalEvent?.({
          event: 'client:logout',
          data: { username: session.username, address: this.remoteAddress(socket) }
        })
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
      loginAt: Date.now(),
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
          // 下载策略：落盘前先征求本机用户同意（拒绝/超时则整个传输被拒）。
          // 同一账户对同一路径 5 分钟内已确认过则免重复确认（中断重初始化不二次弹窗）
          const ok = await this.ensureUploadAccepted(s, p.root, p.path, p.size)
          if (!ok) {
            throw Object.assign(new Error('对方拒绝或确认超时'), { code: 'FORBIDDEN' })
          }
          const r = await ops.createUpload(p.root, p.path)
          // 对方发来文件落下载记录：传输面板可见、有进度；对端取消/断连会同步状态
          const rec = this.store?.create({
            kind: 'ws-recv',
            peer: s.username,
            name: basename(p.path) || p.path,
            remotePath: p.path,
            localPath: ops.resolvePath(p.root, p.path),
            total: Number(p.size ?? 0),
            state: 'active'
          })
          if (rec) {
            this.uploadRecs.set(r.uploadId, rec.id)
            // 连接在完成前断开：记录标记为已中断
            socket.once('close', () => {
              const id = this.uploadRecs.get(r.uploadId)
              if (id === undefined) return
              this.uploadRecs.delete(r.uploadId)
              const cur = this.store?.get(id)
              if (cur && cur.state === 'active') {
                this.store?.update(id, { state: 'interrupted', error: '连接中断' })
              }
            })
          }
          this.reply(socket, req.id, true, r)
          break
        }
        case 'uploadChunk': {
          await ops.appendUpload(p.uploadId, p.offset, p.data)
          const recId = this.uploadRecs.get(p.uploadId)
          if (recId !== undefined) {
            // base64 长度换算落盘字节数（含 padding 修正），回写下载进度
            const decoded =
              Math.floor((p.data.length * 3) / 4) - (p.data.endsWith('==') ? 2 : p.data.endsWith('=') ? 1 : 0)
            const cur = this.store?.get(recId)
            if (cur && cur.state === 'active') {
              this.store?.updateProgress(recId, p.offset + decoded, cur.total)
            }
          }
          this.reply(socket, req.id, true, {})
          break
        }
        case 'uploadFinish': {
          await ops.finishUpload(p.uploadId)
          const recId = this.uploadRecs.get(p.uploadId)
          if (recId !== undefined) {
            this.uploadRecs.delete(p.uploadId)
            const cur = this.store?.get(recId)
            if (cur && cur.state === 'active') this.store?.update(recId, { state: 'completed', error: null })
          }
          this.audit.log(s.username, 'upload', { root: p.root, path: p.path })
          this.reply(socket, req.id, true, {})
          break
        }
        case 'transferGrant':
          await this.handleTransferGrant(s, socket, req)
          break
        case 'p2pPush':
          await this.handleP2pPush(s, socket, req, ops)
          break
        case 'p2pPushStop': {
          // 下载方取消：中止本机上传任务并把上传记录标记为已取消
          const sid = (req.params as { sessionId: string }).sessionId
          const job = this.pushJobs.get(sid)
          if (job) job.aborted = true
          for (const r of this.store?.getBySession(sid) ?? []) {
            if (
              r.kind === 'p2p-send' &&
              (r.state === 'active' || r.state === 'interrupted' || r.state === 'paused')
            ) {
              this.store?.update(r.id, { state: 'cancelled', error: '对方取消了下载' })
            }
          }
          this.reply(socket, req.id, true, {})
          break
        }
        case 'p2pPushPause': {
          // 下载方暂停：挂起本机上传（socket 保留，恢复后原地继续）
          this.pausePush((req.params as { sessionId: string }).sessionId)
          this.reply(socket, req.id, true, {})
          break
        }
        case 'p2pPushResume': {
          // 下载方继续：唤醒已暂停的上传任务
          this.resumePausedPush((req.params as { sessionId: string }).sessionId)
          this.reply(socket, req.id, true, {})
          break
        }
        case 'uploadAbort': {
          await ops.abortUpload((req.params as { uploadId: string }).uploadId)
          const recId = this.uploadRecs.get(p.uploadId)
          if (recId !== undefined) {
            this.uploadRecs.delete(p.uploadId)
            const cur = this.store?.get(recId)
            if (cur && cur.state === 'active') {
              this.store?.update(recId, { state: 'cancelled', error: '对方取消了上传' })
            }
          }
          this.reply(socket, req.id, true, {})
          break
        }
        case 'transferDecision':
          this.handleDecision(s, socket, req)
          break
        case 'getPendingTransfers':
          this.reply(socket, req.id, true, { items: this.transfers.listPending() })
          break
        case 'disconnect':
          // 交给 socket close 事件统一清理会话并发 logout 通知
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

  /** WS 下载确认（对方发起）：下载策略为「需要确认」时征求本机用户同意；已确认过且未过期则直接放行 */
  private async ensureUploadAccepted(
    s: AuthSession,
    root: string,
    path: string,
    size?: number
  ): Promise<boolean> {
    const key = `${s.accountId}:${root}:${path}`
    const approvedAt = this.wsUploadApproved.get(key)
    if (approvedAt && Date.now() - approvedAt < 5 * 60 * 1000) {
      this.wsUploadApproved.set(key, Date.now()) // 滑动续期：传输进行中不弹二次确认
      return true
    }
    const ok = await this.transfers.request({
      sessionId: `ws-upload:${randomUUID()}`,
      from: s.username,
      fileName: basename(path) || path,
      fileCount: 1,
      totalSize: Number(size ?? 0)
    })
    if (ok) this.wsUploadApproved.set(key, Date.now())
    return ok
  }

  private async handleTransferGrant(s: AuthSession, socket: WebSocket, req: RpcRequest): Promise<void> {
    const p = req.params as TransferGrantParams
    const g = s.grants.get(p.root)
    if (!g) throw Object.assign(new Error('未知根目录'), { code: 'FORBIDDEN' })
    const mask = resolvePermission(g.nodes, p.path)
    const base = p.direction === 'send' ? Permission.DOWNLOAD : Permission.UPLOAD
    if (!hasPermission(mask, Permission.TRANSFER) || !hasPermission(mask, base)) {
      throw Object.assign(new Error('无传输权限'), { code: 'FORBIDDEN' })
    }
    const token = generateToken()
    let preAuthorized = false
    // 下载方向（对方要把文件传到本机）：授权时先确认，接受后才发 token，
    // 并标记预授权——上传方连接进来不再二次确认，无需挂连接等待
    if (p.direction === 'receive') {
      const ok = await this.transfers.request({
        sessionId: token,
        from: s.username,
        fileName: p.fileName ?? basename(p.path),
        fileCount: p.fileCount ?? 1,
        totalSize: p.totalSize ?? 0
      })
      if (!ok) {
        throw Object.assign(new Error('对方拒绝或确认超时'), { code: 'FORBIDDEN' })
      }
      preAuthorized = true
    }
    this.transferGrants.set(token, {
      token,
      accountId: s.accountId,
      root: p.root,
      relPath: p.path,
      direction: p.direction,
      expiresAt: Date.now() + GRANT_TTL_MS,
      preAuthorized
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

  /** 本机下载授权：为 P2P 下载创建一次性 token（下载端为本机服务端，写入目录由调用方指定） */
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
      expiresAt: Date.now() + GRANT_TTL_MS,
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

  /** P2P 上传（或续传）准备阶段：校验权限、收集文件、建立/复用记录 */
  private async preparePush(
    p: {
      root: string
      path?: string
      /** 批量多选：多个远端路径一次会话推流（各项顶层名称需唯一，同目录选择天然满足） */
      paths?: string[]
      host: string
      port: number
      sessionId: string
      rename?: string
      peer?: string
    },
    ops?: FileOps
  ): Promise<{
    recId?: number
    fileCount: number
    total: number
    items: Array<{ absPath: string; relPath: string }>
    relPaths: string[]
  }> {
    const fileOps = ops ?? new FileOps(this.systemChecker(p.root))
    // 批量(paths)与单路径(path)统一成 targets；都不存在时（如旧版记录的续传上下文缺失）明确报错，
    // 而不是把 undefined 传进 resolveSafePath 抛出难以理解的「非法路径」
    const targets = p.paths?.length ? p.paths : typeof p.path === 'string' ? [p.path] : []
    if (targets.length === 0) {
      throw Object.assign(new Error('缺少传输路径，无法续传，请重新发起传输'), { code: 'BAD_REQUEST' as const })
    }
    const items = await this.collectTargets(fileOps, p.root, targets)
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
    // 同会话已有上传记录则复用（续传），否则新建
    const existing = this.store?.getBySession(p.sessionId).find((r) => r.kind === 'p2p-send')
    let recId: number | undefined
    if (existing && existing.state !== 'completed') {
      // 仅当确有活跃上传任务时才算冲突；「已标记 active 但任务不在」是续传流程预置的状态，放行
      if (existing.state === 'active' && this.pushJobs.has(p.sessionId)) {
        throw Object.assign(new Error('该传输正在进行中'), { code: 'CONFLICT' as const })
      }
      this.store?.update(existing.id, { state: 'active', error: null, transferred: 0, total })
      recId = existing.id
    } else if (this.store) {
      const rec = this.store.create({
        kind: 'p2p-send',
        peer: p.peer ?? `${p.host}:${p.port}`,
        name: p.rename ? p.rename : targets.length > 1 ? `${targets.length} 个项目` : basename(targets[0]) || '传输',
        remotePath: targets.length > 1 ? `${targets[0]} 等 ${targets.length} 项` : targets[0],
        localPath: '',
        total,
        state: 'active',
        sessionId: p.sessionId,
        resume: JSON.stringify({
          root: p.root,
          path: p.path,
          // 始终保留完整目标列表：单选批量下载（paths 只有一项）此前 paths 不落盘、
          // path 又不存在，续传时 collectTargets 收到 [undefined] 抛「非法路径」
          paths: targets,
          host: p.host,
          port: p.port,
          sessionId: p.sessionId,
          rename: p.rename,
          peer: p.peer
        })
      })
      recId = rec.id
    }
    return { recId, fileCount: items.length, total, items, relPaths }
  }

  /** 收集多个远端路径的待上传文件（目录递归展开），按 relPath 去重并要求非空 */
  private async collectTargets(
    fileOps: FileOps,
    root: string,
    targets: string[]
  ): Promise<Array<{ absPath: string; relPath: string }>> {
    const out: Array<{ absPath: string; relPath: string }> = []
    const seen = new Set<string>()
    for (const t of targets) {
      for (const f of await fileOps.collectForTransfer(root, t)) {
        if (seen.has(f.relPath)) continue
        seen.add(f.relPath)
        out.push(f)
      }
    }
    if (out.length === 0) {
      throw Object.assign(new Error('没有可下载的文件'), { code: 'BAD_REQUEST' as const })
    }
    return out
  }

  /** P2P 上传执行阶段：建立任务注册表并发送（数据不经 WS 命令通道） */
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
    const job = { aborted: false, paused: false }
    // 同会话旧任务仍在（如暂停后走了完整续传）：置 abort 让其退出，避免双任务双 socket
    const prev = this.pushJobs.get(p.sessionId)
    if (prev) prev.aborted = true
    this.pushJobs.set(p.sessionId, job)
    let sentBytes = 0
    /** 本次会话已写入 socket 的字节数（未 ACK 也计入） */
    let writtenBytes = 0
    let lastStore = 0
    try {
      await sendFiles({
        host: p.host,
        port: Number(p.port),
        token: p.p2pToken,
        sessionId: p.sessionId,
        resume: p.resume === true,
        shouldAbort: () => job.aborted,
        shouldPause: () => job.paused === true,
        onSent: (n) => {
          writtenBytes = n
        },
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
        // 未发出任何字节且磁盘上没有历史数据（拒绝/超时/连不上）→ 已取消；
        // 已发出过字节（ACK 或已写入 socket）、或续传基线前失败但磁盘已有部分文件 → 已中断（可续传）
        const prevBytes = ctx.recId !== undefined ? (this.store?.get(ctx.recId)?.transferred ?? 0) : 0
        const state = sentBytes > 0 || writtenBytes > 0 || prevBytes > 0 ? 'interrupted' : 'cancelled'
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

  /** 取消上传任务（传输面板「取消」） */
  cancelPush(sessionId: string, reason: string): void {
    const job = this.pushJobs.get(sessionId)
    if (job) job.aborted = true
    for (const r of this.store?.getBySession(sessionId) ?? []) {
      if (
        r.kind === 'p2p-send' &&
        (r.state === 'active' || r.state === 'interrupted' || r.state === 'paused')
      ) {
        this.store?.update(r.id, { state: 'cancelled', error: reason })
      }
    }
  }

  /** 同步本机上传（p2p-send）记录的暂停状态：任意一端暂停/恢复，两端记录状态一致 */
  private setSendPaused(sessionId: string, paused: boolean): void {
    for (const r of this.store?.getBySession(sessionId) ?? []) {
      if (r.kind !== 'p2p-send') continue
      if (paused && r.state === 'active') {
        this.store?.update(r.id, { state: 'paused', error: '已暂停' })
      } else if (!paused && r.state === 'paused') {
        this.store?.update(r.id, { state: 'active', error: null })
      }
    }
  }

  /** 暂停上传任务（挂起上传，socket 保留）；同步本机记录并广播给对端；返回是否存在活跃任务 */
  pausePush(sessionId: string): boolean {
    const job = this.pushJobs.get(sessionId)
    if (!job) return false
    job.paused = true
    this.setSendPaused(sessionId, true)
    this.broadcast({ event: 'transfer:progress', data: { sessionId, paused: true } })
    return true
  }

  /** 恢复已暂停的上传任务（原地继续）；同步本机记录并广播给对端；返回是否存在已暂停任务 */
  resumePausedPush(sessionId: string): boolean {
    const job = this.pushJobs.get(sessionId)
    if (!job || !job.paused) return false
    job.paused = false
    this.setSendPaused(sessionId, false)
    this.broadcast({ event: 'transfer:progress', data: { sessionId, paused: false } })
    return true
  }

  /** 下载端主动中止：断开该会话的下载 socket（上传端会感知失败；已收部分保留，可断点续传） */
  abortReceive(sessionId: string): void {
    const s = this.recvSockets.get(sessionId)
    if (s) s.destroy()
  }

  /** 续传上传（记录里的 resume 上下文） */
  async resumePush(r: {
    root: string
    path?: string
    paths?: string[]
    host: string
    port: number
    sessionId: string
    rename?: string
    peer?: string
  }): Promise<void> {
    const fileOps = new FileOps(this.systemChecker(r.root))
    const prepared = await this.preparePush({ ...r }, fileOps)
    // 完整重放前同步恢复状态：本机遗留的「已暂停」记录回到进行中，
    // 并广播告知对端（如发送端重启后原任务已不在，对端暂停记录不能再等原地唤醒）
    this.setSendPaused(r.sessionId, false)
    this.broadcast({ event: 'transfer:progress', data: { sessionId: r.sessionId, paused: false } })
    await this.executePush(
      {
        root: r.root,
        path: r.path ?? r.paths?.[0] ?? '',
        host: r.host,
        port: r.port,
        sessionId: r.sessionId,
        p2pToken: r.sessionId,
        rename: r.rename,
        resume: true,
        username: 'resume'
      },
      {
        recId: prepared.recId,
        items: prepared.items.map((f, i) => ({ absPath: f.absPath, relPath: prepared.relPaths[i] })),
        total: prepared.total
      }
    )
  }

  /** P2P 上传：服务端直接从磁盘分块推流给对端下载端口，不经 WS 命令通道，无大小限制 */
  private async handleP2pPush(
    s: AuthSession,
    socket: WebSocket,
    req: RpcRequest,
    ops: FileOps
  ): Promise<void> {
    const p = req.params as {
      root: string
      path?: string
      /** 批量多选：多个远端路径一次会话推流 */
      paths?: string[]
      host: string
      port: number
      p2pToken: string
      sessionId: string
      rename?: string
      resume?: boolean
    }
    const prepared = await this.preparePush(
      { root: p.root, path: p.path, paths: p.paths, host: p.host, port: Number(p.port), sessionId: p.sessionId, rename: p.rename },
      ops
    )
    this.reply(socket, req.id, true, { fileCount: prepared.fileCount })
    const firstName = p.paths?.length ? p.paths[0] : (p.path ?? '')
    this.audit.log(s.username, 'p2p:push', {
      root: p.root,
      path: firstName,
      files: prepared.fileCount,
      to: `${p.host}:${p.port}`
    })
    // 异步执行：下载由对端发起，需本机服务端确认后才上传（下载端是发起方本机，已免确认）
    void (async () => {
      // 断点续传：同会话已有上传记录 → 沿用既有授权，免二次确认
      const isResume = p.resume === true && prepared.recId !== undefined
      if (!isResume) {
        const ok = await this.transfers.request({
          sessionId: p.sessionId,
          from: s.username,
          fileName: p.rename ?? basename(firstName),
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
          this.audit.log(s.username, 'p2p:push:fail', { root: p.root, path: firstName, error: '已拒绝或确认超时' })
          return
        }
      }
      await this.executePush(
        {
          root: p.root,
          path: firstName,
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
          items: prepared.items.map((f, i) => ({ absPath: f.absPath, relPath: prepared.relPaths[i] })),
          total: prepared.total
        }
      )
    })().catch(() => {
      /* 状态已在 executePush 内落库并广播 */
    })
  }

  /**
   * 接受对端上传后补建 P2P 下载记录（本机发起的下载在 prepareReceive 时已预建，不会走到这里）。
   * resume 上下文保留下载目录：续传握手时 validateToken 的 resume 兜底分支读取 ctx.dir 重建授权。
   */
  private createRecvRecord(
    g: TransferGrantRecord,
    from: string,
    info: { fileName: string; fileCount: number; totalSize: number; sessionId: string }
  ): void {
    this.store?.create({
      kind: 'p2p-recv',
      peer: from,
      name: basename(info.fileName) || '传输',
      remotePath: info.fileName,
      localPath: g.root,
      total: info.totalSize,
      state: 'active',
      sessionId: info.sessionId,
      resume: JSON.stringify({ dir: g.root })
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
