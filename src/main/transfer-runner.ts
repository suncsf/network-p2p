import { open, lstat, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ConnectionManager } from './client/manager'
import type { LatticeServer } from './server/service'
import type { TransferStore } from './transfers'
import type { TransferRecord as Rec } from '@shared/protocol'

/** 上传分块大小（与渲染层旧实现一致：4MB/块） */
const UPLOAD_CHUNK = 4 * 1024 * 1024

export interface StartUploadParams {
  connId: string
  /** 远端授权根目录 */
  root: string
  /** 远端目标路径（相对根目录） */
  path: string
  /** 本机源文件绝对路径 */
  filePath: string
  name: string
  size: number
  peer?: string
}

export interface StartUploadBatchParams {
  connId: string
  /** 远端授权根目录 */
  root: string
  /** 远端目标目录（相对根目录，可为空串表示根） */
  baseDir: string
  /** 本机源路径（文件或目录，可混合；目录递归展开并保留结构） */
  sources: string[]
  peer?: string
}

/** 批量展开结果 */
export interface BatchUploadResult {
  /** 展开后的文件数 */
  count: number
  /** 总字节数 */
  total: number
}

interface ExpandedFile {
  filePath: string
  /** 相对 baseDir 的远端路径（'/' 分隔，含顶层名） */
  relPath: string
  size: number
}

/** 展开上传源：文件原样保留；目录递归展开（不跟随符号链接），远端路径用 '/' 拼接 */
async function expandSources(sources: string[]): Promise<{ files: ExpandedFile[]; emptyDirs: string[] }> {
  const files: ExpandedFile[] = []
  const dirs: string[] = []
  const walk = async (abs: string, rel: string): Promise<void> => {
    const st = await lstat(abs)
    if (st.isDirectory()) {
      dirs.push(rel)
      for (const c of await readdir(abs)) {
        await walk(join(abs, c), `${rel}/${c}`)
      }
    } else if (st.isFile()) {
      let size = 0
      try {
        size = (await stat(abs)).size
      } catch {
        /* 瞬时不可统计按 0 处理 */
      }
      files.push({ filePath: abs, relPath: rel, size })
    }
  }
  for (const src of sources) {
    const top = basename(src)
    const st = await lstat(src)
    if (st.isDirectory()) {
      await walk(src, top)
    } else if (st.isFile()) {
      let size = 0
      try {
        size = (await stat(src)).size
      } catch {
        /* 同上 */
      }
      files.push({ filePath: src, relPath: top, size })
    }
  }
  // 空目录不会随 uploadInit 隐式创建，单独收集后补建
  const emptyDirs = dirs.filter((d) => !files.some((f) => f.relPath.startsWith(`${d}/`)))
  return { files, emptyDirs }
}

interface UploadResume {
  connId: string
  /** 原连接端点：重启后 connId 失效时按此匹配现存连接续传 */
  host?: string
  port?: number
  username?: string
  root: string
  path: string
  filePath: string
  size: number
  uploadId: string | null
  offset: number
}

interface RecvResume {
  connId: string
  /** 原连接端点：重启后 connId 失效时按此匹配现存连接续传 */
  host?: string
  port?: number
  username?: string
  root: string
  path: string
  dir: string
  rename?: string
  isDir: boolean
  name: string
}

export interface TransferDoneInfo {
  ok: boolean
  name: string
  message?: string
}

function abortedError(): Error {
  return Object.assign(new Error('已取消'), { code: 'ABORTED' })
}

/**
 * 传输任务执行器：
 * - 上传：主进程分块循环（4MB/块），支持取消与断点续传
 * - 取消/续传：按记录类型分发到本地任务或服务端推送任务
 */
export class TransferRunner {
  /** 进行中的上传任务（记录 id → 任务） */
  private jobs = new Map<number, { aborted: boolean }>()

  /** 批量上传队列：按顺序执行，避免同时发起大量传输 */
  private queue: number[] = []
  private pumping = false

  constructor(
    private store: TransferStore,
    private conns: ConnectionManager,
    private server: LatticeServer,
    /** 传输结束通知（主进程用于系统通知） */
    private onDone?: (info: TransferDoneInfo) => void
  ) {}

  private connected(connId: string): boolean {
    return this.conns.get(connId)?.state === 'connected'
  }

  /**
   * 解析可用于续传的连接：优先原 connId；连接断开（如应用重启后 id 变化）
   * 时按 host/port/username 匹配现存连接，最后按对端用户名兜底匹配。
   */
  private resolveConn(
    r: { connId?: string; host?: string; port?: number; username?: string },
    peer?: string
  ): string | null {
    if (r.connId && this.connected(r.connId)) return r.connId
    const all = this.conns.list().filter((c) => c.state === 'connected')
    const hit =
      all.find(
        (c) =>
          r.host !== undefined &&
          r.port !== undefined &&
          c.host === r.host &&
          c.port === r.port &&
          c.username === r.username
      ) ?? all.find((c) => peer !== undefined && c.username === peer)
    return hit?.id ?? null
  }

  /* ------------------------------ 上传 ------------------------------ */

  /** 发起上传：创建记录并异步执行，立即返回记录（进度通过 transfer:updated 推送） */
  startUpload(p: StartUploadParams): Rec {
    const peer = p.peer || this.conns.get(p.connId)?.username || '远端'
    const info = this.conns.get(p.connId)
    const resume: UploadResume = {
      connId: p.connId,
      host: info?.host,
      port: info?.port,
      username: info?.username,
      root: p.root,
      path: p.path,
      filePath: p.filePath,
      size: p.size,
      uploadId: null,
      offset: 0
    }
    const rec = this.store.create({
      kind: 'upload',
      peer,
      name: p.name,
      remotePath: p.path,
      localPath: p.filePath,
      total: p.size,
      state: 'active',
      resume: JSON.stringify(resume)
    })
    void this.runUpload(rec.id).catch(() => {})
    return rec
  }

  /**
   * 批量上传：展开选中的文件/目录（保留目录结构），每个文件一条上传记录，
   * 依次排队执行（可单独取消/续传，进度见传输面板）。
   */
  async startUploadBatch(p: StartUploadBatchParams): Promise<BatchUploadResult> {
    const { files, emptyDirs } = await expandSources(p.sources)
    if (files.length === 0 && emptyDirs.length === 0) {
      throw Object.assign(new Error('没有可上传的文件'), { code: 'BAD_REQUEST' as const })
    }
    const peer = p.peer || this.conns.get(p.connId)?.username || '远端'
    const info = this.conns.get(p.connId)
    let total = 0
    for (const f of files) {
      const remote = p.baseDir ? `${p.baseDir}/${f.relPath}` : f.relPath
      const resume: UploadResume = {
        connId: p.connId,
        host: info?.host,
        port: info?.port,
        username: info?.username,
        root: p.root,
        path: remote,
        filePath: f.filePath,
        size: f.size,
        uploadId: null,
        offset: 0
      }
      const rec = this.store.create({
        kind: 'upload',
        peer,
        name: basename(f.relPath),
        remotePath: remote,
        localPath: f.filePath,
        total: f.size,
        state: 'active',
        resume: JSON.stringify(resume)
      })
      total += f.size
      this.enqueue(rec.id)
    }
    // 空目录单独补建（uploadInit 只会隐式创建含文件的父目录）；无 WRITE 权限时忽略
    for (const d of emptyDirs) {
      await this.conns
        .request(p.connId, 'mkdir', { root: p.root, path: p.baseDir ? `${p.baseDir}/${d}` : d })
        .catch(() => {})
    }
    return { count: files.length, total }
  }

  private enqueue(recId: number): void {
    this.queue.push(recId)
    void this.pump()
  }

  /** 顺序消费上传队列：一次传一个文件，完成或中断后继续下一个 */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!
        // 排队期间被取消/删除的记录直接跳过
        if (this.store.get(id)?.state !== 'active') continue
        await this.runUpload(id)
      }
    } finally {
      this.pumping = false
    }
  }

  private async runUpload(recId: number): Promise<void> {
    const rec = this.store.get(recId)
    const resumeJson = this.store.getResume(recId)
    if (!rec || !resumeJson) return
    const r = JSON.parse(resumeJson) as UploadResume
    const job = { aborted: false }
    this.jobs.set(recId, job)
    try {
      // 原连接可能已失效（重启后 id 变化）：按端点信息匹配现存连接
      const connId = this.resolveConn(r, rec.peer)
      if (!connId) throw new Error('没有可用的连接，无法上传，请重新连接后重试')
      await this.uploadLoop(recId, r, job, connId)
      this.store.update(recId, { state: 'completed', transferred: r.size, error: null })
      this.onDone?.({ ok: true, name: rec.name })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (job.aborted || err.code === 'ABORTED') {
        this.store.update(recId, { state: 'cancelled', error: '已取消' })
      } else {
        // 保留断点：记录当前偏移与 uploadId，供续传
        this.store.update(recId, {
          state: 'interrupted',
          error: err.message,
          resume: JSON.stringify(r)
        })
        this.onDone?.({ ok: false, name: rec.name, message: err.message })
      }
    } finally {
      this.jobs.delete(recId)
    }
  }

  private async uploadLoop(recId: number, r: UploadResume, job: { aborted: boolean }, connId: string): Promise<void> {
    // 源文件仍需存在且足够大
    let localSize = r.size
    try {
      localSize = (await stat(r.filePath)).size
    } catch {
      throw new Error('本地源文件不存在或不可读')
    }
    if (localSize < r.size) throw new Error('本地源文件已变化，无法续传，请重新发起')

    const fh = await open(r.filePath, 'r')
    try {
      let offset = r.offset ?? 0
      let uploadId = r.uploadId
      if (!uploadId) {
        const res = (await this.conns.request(connId, 'uploadInit', {
          root: r.root,
          path: r.path,
          size: r.size
        })) as { uploadId: string }
        uploadId = res.uploadId
        r.uploadId = uploadId
        offset = 0
      }
      let lastNotify = 0
      while (offset < r.size) {
        if (job.aborted) throw abortedError()
        const len = Math.min(UPLOAD_CHUNK, r.size - offset)
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, offset)
        try {
          await this.conns.request(connId, 'uploadChunk', {
            uploadId,
            offset,
            data: buf.toString('base64')
          })
        } catch (e) {
          const msg = (e as Error).message ?? ''
          const code = (e as { code?: string }).code
          if (code === 'NOT_FOUND' || msg.includes('未知上传')) {
            // 服务端不认识该上传（可能重启过）：从头重新初始化
            const res = (await this.conns.request(connId, 'uploadInit', {
              root: r.root,
              path: r.path,
              size: r.size
            })) as { uploadId: string }
            uploadId = res.uploadId
            r.uploadId = uploadId
            offset = 0
            continue
          }
          throw e
        }
        offset += len
        r.offset = offset
        const now = Date.now()
        if (now - lastNotify > 250 || offset === r.size) {
          lastNotify = now
          this.store.updateProgress(recId, offset, r.size)
        }
      }
      await this.conns.request(connId, 'uploadFinish', { uploadId })
    } finally {
      await fh.close()
    }
  }

  /* ------------------------------ 取消 / 续传 ------------------------------ */

  /** 取消一条传输记录（仅进行中的可取消） */
  async cancel(id: number): Promise<void> {
    const rec = this.store.get(id)
    if (!rec) throw new Error('记录不存在')
    if (rec.state !== 'active') throw new Error('该传输已结束')
    if (rec.kind === 'upload') {
      const job = this.jobs.get(id)
      if (job) job.aborted = true
      const rj = this.store.getResume(id)
      const r = rj ? (JSON.parse(rj) as UploadResume) : null
      if (r?.uploadId && this.connected(r.connId)) {
        await this.conns.request(r.connId, 'uploadAbort', { uploadId: r.uploadId }).catch(() => {})
      }
      this.store.update(id, { state: 'cancelled', error: '已取消' })
      return
    }
    if (rec.kind === 'p2p-send') {
      this.server.cancelPush(rec.sessionId, '已取消')
      return
    }
    if (rec.kind === 'p2p-recv') {
      // 1) 断开本机接收 socket；2) 通知发送端停止推送；3) 标记已取消
      this.server.abortReceive(rec.sessionId)
      const rj = this.store.getResume(id)
      const r = rj ? (JSON.parse(rj) as RecvResume) : null
      if (r?.connId && this.connected(r.connId)) {
        await this.conns
          .request(r.connId, 'p2pPushStop', { sessionId: rec.sessionId })
          .catch(() => {})
      }
      this.store.update(id, { state: 'cancelled', error: '已取消' })
    }
  }

  /** 断点续传（已中断；P2P 取消的记录保留部分文件，也允许续传） */
  async resume(id: number): Promise<void> {
    const rec = this.store.get(id)
    if (!rec) throw new Error('记录不存在')
    if (rec.state === 'active') throw new Error('传输正在进行中')
    const resumeJson = this.store.getResume(id)
    if (!resumeJson) throw new Error('该记录没有续传信息')
    const canResume = rec.state === 'interrupted' || (rec.state === 'cancelled' && rec.kind !== 'upload')
    if (!canResume) throw new Error('该记录不支持续传')

    if (rec.kind === 'upload') {
      const r = JSON.parse(resumeJson) as UploadResume
      const connId = this.resolveConn(r, rec.peer)
      if (!connId) {
        throw new Error('没有可用的连接，无法续传，请重新连接后重试')
      }
      r.connId = connId
      this.store.update(id, { state: 'active', error: null, resume: JSON.stringify(r) })
      void this.runUpload(id).catch(() => {})
      return
    }

    if (rec.kind === 'p2p-recv') {
      const r = JSON.parse(resumeJson) as RecvResume
      const connId = this.resolveConn(r, rec.peer)
      if (!connId) {
        throw new Error('没有可用的连接，无法续传，请重新连接后重试')
      }
      // 用原 sessionId 重建接收授权（免对话框），对端可按原会话续传
      const grant = this.server.createLocalTransferGrant(r.dir, { token: rec.sessionId })
      this.store.update(id, { state: 'active', error: null })
      try {
        await this.conns.request(connId, 'p2pPush', {
          root: r.root,
          path: r.path,
          host: grant.host,
          port: grant.port,
          p2pToken: grant.p2pToken,
          sessionId: rec.sessionId,
          rename: r.rename,
          resume: true
        })
      } catch (e) {
        this.store.update(id, { state: 'interrupted', error: (e as Error).message })
        throw e
      }
      return
    }

    // p2p-send：重放推送（接收端校验 token，仍有效则从断点继续）
    const r = JSON.parse(resumeJson) as {
      root: string
      path: string
      host: string
      port: number
      sessionId: string
      rename?: string
    }
    this.store.update(id, { state: 'active', error: null })
    try {
      await this.server.resumePush(r)
    } catch (e) {
      this.store.update(id, { state: 'interrupted', error: (e as Error).message })
      throw e
    }
  }
}
