import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import {
  P2PFrameType,
  P2P_MAGIC,
  P2P_VERSION,
  MAX_FRAME_SIZE,
  DEFAULT_CHUNK_SIZE,
  encodeHeader,
  decodeHeader,
  type P2PManifest,
  type P2PManifestFile
} from '@shared/p2p-frames'

/** 写入一个完整帧 */
export function writeFrame(socket: net.Socket, type: P2PFrameType, payload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) return reject(new Error('连接已关闭'))
    const header = encodeHeader({ magic: P2P_MAGIC, version: P2P_VERSION, type, length: payload.length })
    socket.write(header)
    socket.write(payload, (err) => (err ? reject(err) : resolve()))
  })
}

/** 帧解析器：累积缓冲区并回调完整帧 */
export class FrameParser {
  private buffer = Buffer.alloc(0)
  constructor(private onFrame: (type: P2PFrameType, payload: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buffer = (this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])) as Buffer<ArrayBuffer>
    while (this.buffer.length >= 12) {
      const header = decodeHeader(this.buffer)
      if (header.magic !== P2P_MAGIC) {
        this.buffer = Buffer.alloc(0)
        throw new Error('P2P magic 校验失败')
      }
      if (header.version !== P2P_VERSION) {
        this.buffer = Buffer.alloc(0)
        throw new Error(`P2P 协议版本不匹配（本端 v${P2P_VERSION}，对端 v${header.version}），请两端都更新到同一版本`)
      }
      if (header.length > MAX_FRAME_SIZE) throw new Error('P2P 帧过大')
      if (this.buffer.length < 12 + header.length) return
      const payload = this.buffer.subarray(12, 12 + header.length)
      this.buffer = this.buffer.subarray(12 + header.length)
      this.onFrame(header.type, Buffer.from(payload))
    }
  }
}

export function encodeHello(token: string, sessionId: string, resume = false): Buffer {
  return Buffer.from(JSON.stringify({ token, sessionId, resume }), 'utf8')
}

export function encodeDecision(accepted: boolean, reason?: string): Buffer {
  return Buffer.from(JSON.stringify({ accepted, reason }), 'utf8')
}

export function encodeError(code: string, message: string): Buffer {
  return Buffer.from(JSON.stringify({ code, message }), 'utf8')
}

export function encodeManifest(m: P2PManifest): Buffer {
  return Buffer.from(JSON.stringify(m), 'utf8')
}

export function encodeChunk(fileId: number, offset: number, data: Uint8Array): Buffer {
  // v2：偏移量用 BigUInt64，文件可超过 4GB（UInt32 上限 4294967295，越界抛 RangeError 导致中断）
  const buf = Buffer.alloc(12 + data.length)
  buf.writeUInt32BE(fileId, 0)
  buf.writeBigUInt64BE(BigInt(offset), 4)
  buf.set(data, 12)
  return buf
}

export interface P2PSendOptions {
  host: string
  port: number
  token: string
  sessionId: string
  files: Array<{ id: number; absPath: string; relPath: string }>
  onProgress?: (sent: number, total: number) => void
  chunkSize?: number
  /** 断点续传：HELLO 携带 resume，下载端返回已收偏移，从偏移继续 */
  resume?: boolean
  /** 每个分块发送前轮询；返回 true 时中止（抛出「传输已取消」） */
  shouldAbort?: () => boolean
  /** 每个分块发送前轮询；返回 true 期间挂起等待（暂停），恢复后原地继续 */
  shouldPause?: () => boolean
  /** 每个分块写入 socket 后回调（未 ACK 也计入）：用于失败时判定「传输确已开始」 */
  onSent?: (written: number) => void
}

/** 计算单文件 SHA-256 与大小 */
export async function hashFile(absPath: string): Promise<{ size: number; sha256: string }> {
  const st = await stat(absPath)
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(absPath)
    s.on('data', (d) => hash.update(d))
    s.on('end', () => resolve())
    s.on('error', reject)
  })
  return { size: st.size, sha256: hash.digest('hex') }
}

/**
 * 上传端：连接对端，发送清单与分块，等待完成确认。
 * 断点续传：resume=true 时下载端在 DECISION 里返回各文件已收偏移，从偏移继续上传。
 */
export async function sendFiles(opts: P2PSendOptions): Promise<void> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE
  const manifestFiles: P2PManifestFile[] = []
  const sizes = new Map<number, number>()
  let total = 0
  for (const f of opts.files) {
    // 仅 stat 取大小，不做 SHA-256：全量哈希需要把每个文件完整读一遍盘，
    // 50GB 级传输会在连接前空载数分钟（期间进度 0%、下载授权可能过期），
    // 且下载端从不校验 sha256，这里不再计算，清单中留空
    const size = (await stat(f.absPath)).size
    manifestFiles.push({ id: f.id, path: f.relPath, size, sha256: '' })
    sizes.set(f.id, size)
    total += size
  }

  const socket = net.connect({ host: opts.host, port: opts.port })
  // 等待下载方对 MANIFEST 的确认（DECISION），确认后才推流分块
  let rejectReason = '对方拒绝或连接已断开'
  let recvOffsets: Record<number, number> = {}
  /** 对端已确认落盘的字节数（含续传基线）——进度以此为准，与下载端显示一致 */
  let acked = 0
  let decide!: (ok: boolean) => void
  const decided = new Promise<boolean>((resolve) => (decide = resolve))
  const parser = new FrameParser((type, payload) => {
    if (type === P2PFrameType.DECISION) {
      const d = JSON.parse(payload.toString('utf8')) as {
        accepted: boolean
        reason?: string
        offsets?: Record<number, number>
      }
      recvOffsets = d.offsets ?? {}
      decide(d.accepted)
    } else if (type === P2PFrameType.ACK) {
      // v2 ACK：fileId(4) + offset(BigUInt64) + length(4) = 16 字节
      if (payload.length >= 16) acked += payload.readUInt32BE(12)
      opts.onProgress?.(acked, total)
    } else if (type === P2PFrameType.ERROR) {
      try {
        const e = JSON.parse(payload.toString('utf8')) as { message?: string }
        if (e.message) rejectReason = `对方拒绝下载：${e.message}`
      } catch {
        /* ignore */
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  socket.on('error', () => {})
  socket.on('data', (c) => {
    try {
      parser.push(c)
    } catch {
      socket.destroy()
    }
  })
  socket.once('close', () => decide(false))

  await writeFrame(socket, P2PFrameType.HELLO, encodeHello(opts.token, opts.sessionId, opts.resume === true))
  await writeFrame(
    socket,
    P2PFrameType.MANIFEST,
    encodeManifest({ totalSize: total, files: manifestFiles })
  )

  const accepted = await decided
  if (!accepted) {
    socket.destroy()
    throw new Error(rejectReason)
  }

  // 断点续传：对端已收到的字节数作为进度基线
  for (const f of opts.files) {
    const size = sizes.get(f.id) ?? 0
    acked += Math.max(0, Math.min(recvOffsets[f.id] ?? 0, size))
  }
  opts.onProgress?.(acked, total)
  let written = 0
  for (const f of opts.files) {
    const size = sizes.get(f.id) ?? 0
    let offset = Math.max(0, Math.min(recvOffsets[f.id] ?? 0, size))
    if (offset >= size) continue // 该文件已完整
    const fh = await open(f.absPath, 'r')
    try {
      while (offset < size) {
        if (opts.shouldAbort?.()) {
          socket.destroy()
          throw new Error('传输已取消')
        }
        // 暂停：挂起发送（socket 保留），轮询等恢复；暂停期间取消仍要能退出
        while (opts.shouldPause?.()) {
          if (opts.shouldAbort?.()) {
            socket.destroy()
            throw new Error('传输已取消')
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 150))
        }
        // 背压保护：对端落盘慢时 TCP 缓冲会在内存里无限积压（大文件可达数 GB），
        // 超过高水位先暂停发送，等 socket 排空再继续
        if (socket.bufferSize > 16 * 1024 * 1024) {
          await new Promise<void>((resolve) => socket.once('drain', resolve))
          if (opts.shouldAbort?.()) {
            socket.destroy()
            throw new Error('传输已取消')
          }
        }
        const len = Math.min(chunkSize, size - offset)
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, offset)
        await writeFrame(socket, P2PFrameType.CHUNK, encodeChunk(f.id, offset, buf))
        offset += len
        written += len
        opts.onSent?.(written)
      }
    } finally {
      await fh.close()
    }
  }

  await writeFrame(socket, P2PFrameType.DONE, Buffer.alloc(0))
  await new Promise<void>((resolve) => socket.end(() => resolve()))
}

export interface P2PReceiveOptions {
  /** 固定根目录；若提供 resolveBaseDir 则优先使用动态根 */
  baseDir: string
  /** 根据会话动态解析下载根目录（例如按 transfer grant 的账户目录） */
  resolveBaseDir?: (sessionId: string) => string | undefined
  /** 重名冲突「重命名」时的本地名称映射（清单相对路径 → 本地相对路径），由会话授权携带 */
  mapRelPath?: (sessionId: string, relPath: string) => string | undefined
  /** 校验 token 是否有效（resume=true 表示这是续传连接，可走兜底重建授权） */
  validateToken: (token: string, resume: boolean) => boolean
  /** 请求下载确认；返回是否接受（resume=true 表示这是续传连接） */
  requestConfirm: (info: {
    fileName: string
    fileCount: number
    totalSize: number
    sessionId: string
    resume: boolean
  }) => Promise<boolean>
  /** HELLO 校验通过后回调（用于注册 socket，支持下载端主动中止） */
  onSocket?: (sessionId: string, socket: net.Socket) => void
  /** 下载进度（分块落盘后回调） */
  onProgress?: (received: number, total: number, sessionId: string) => void
  /** 收到 DONE 帧、全部文件落盘完成 */
  onDone?: (sessionId: string) => void
  /** 连接在完成前中断（可断点续传） */
  onInterrupted?: (sessionId: string, received: number) => void
  chunkSize?: number
}

/** 接收过程先写入的临时文件后缀，完成后更名为正式名称 */
const TMP_SUFFIX = '.tmp'

/** P2P 接收端服务器：附带「标记用户主动取消」能力（关闭后清理临时文件） */
export interface P2PReceiveServer extends net.Server {
  /** 标记会话为用户主动取消：socket 关闭后删除该会话已生成的 .tmp 临时文件（区别于网络中断的保留续传） */
  markCancelled: (sessionId: string) => void
}

/** 下载端：监听端口，处理单个传输连接 */
export function createReceiveServer(opts: P2PReceiveOptions): P2PReceiveServer {
  /** 用户主动取消的会话（下载端取消 / 拒绝继续），socket 关闭后删除临时文件 */
  const cancelledSessions = new Set<string>()
  const server = net.createServer((socket) => {
    const parser = new FrameParser(onFrame)
    socket.on('data', (c) => {
      try {
        parser.push(c)
      } catch (e) {
        socket.destroy(e as Error)
      }
    })
    socket.on('error', () => {})

    let tokenValid = false
    let accepted = false
    let manifest: P2PManifest | null = null
    let sessionId = ''
    let resumeMode = false
    let received = 0
    let doneReceived = false
    const offsets = new Map<number, number>()
    const writers = new Map<number, import('node:fs/promises').FileHandle>()

    /** 解析清单文件的本地目标路径：应用重名「重命名」映射，统一安全校验 */
    function resolveTarget(f: { path: string }): { abs: string; tmp: string } {
      const mapped = opts.mapRelPath?.(sessionId, f.path) ?? f.path
      const segments = mapped.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.')
      if (segments.some((s) => s === '..') || path.isAbsolute(mapped)) {
        throw new Error('清单包含非法路径')
      }
      const abs = path.resolve(receiveBase(), ...segments)
      const rel = path.relative(receiveBase(), abs)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('清单路径越界')
      }
      return { abs, tmp: abs + TMP_SUFFIX }
    }

    /** 删除该会话所有已生成的临时文件（用户取消传输时调用） */
    async function cleanupTmp(): Promise<void> {
      if (!manifest) return
      for (const f of manifest.files) {
        try {
          await rm(resolveTarget(f).tmp, { force: true })
        } catch {
          /* 单个文件清理失败不阻断其余 */
        }
      }
    }

    /** 全部接收完成：关闭句柄后把 .tmp 临时文件更名为正式名称（覆盖时先删除同名旧文件） */
    async function finalizeFiles(): Promise<void> {
      if (!manifest) return
      for (const f of manifest.files) {
        try {
          const { abs, tmp } = resolveTarget(f)
          const hasTmp = await stat(tmp).then(
            () => true,
            () => false
          )
          if (hasTmp) {
            // Windows 下 rename 不覆盖已存在文件：覆盖语义先删除同名旧文件再更名
            // （不递归：目标是目录时更名失败并保留 .tmp，避免误删整个目录）
            await rm(abs, { force: true })
            await rename(tmp, abs)
          } else if (f.size === 0) {
            // 零字节文件没有分块传输：直接落一个空文件
            await writeFile(abs, Buffer.alloc(0))
          }
        } catch {
          /* 单个文件更名失败不阻断其余 */
        }
      }
    }

    socket.on('close', () => {
      // 等已入队帧全部处理完（DONE 置位 doneReceived、尾部 CHUNK 落盘）再收尾，
      // 避免把已完成的传输误报为中断、或提前关闭仍在写的句柄
      void frameQueue.then(async () => {
        // 完成前断开：通知上层（保留部分文件，可断点续传）
        if (tokenValid && accepted && !doneReceived) {
          try {
            opts.onInterrupted?.(sessionId, received)
          } catch {
            /* ignore */
          }
        }
        for (const fh of writers.values()) await fh.close().catch(() => {})
        writers.clear()
        // 用户主动取消：删除已生成的临时文件（网络中断则保留 .tmp 以支持断点续传）
        if (cancelledSessions.has(sessionId)) {
          cancelledSessions.delete(sessionId)
          await cleanupTmp()
        }
      })
    })

    function receiveBase(): string {
      if (opts.resolveBaseDir) {
        const b = opts.resolveBaseDir(sessionId)
        if (!b) throw new Error('无法解析下载目录')
        return b
      }
      return opts.baseDir
    }

    /** 帧处理串行化：按到达顺序依次处理。小文件的 CHUNK 与 DONE 会挤在同一次 data 事件里，
     *  若并发处理，DONE 会在 CHUNK 落盘前执行（临时文件还不存在 → 永远不会更名为正式文件） */
    let frameQueue: Promise<void> = Promise.resolve()
    let frameFatal = false
    function onFrame(type: P2PFrameType, payload: Buffer): void {
      frameQueue = frameQueue
        .then(() => {
          if (frameFatal) return
          return handleFrame(type, payload)
        })
        .catch((e) => {
          frameFatal = true
          if (!socket.destroyed) socket.destroy(e as Error)
        })
    }    async function handleFrame(type: P2PFrameType, payload: Buffer): Promise<void> {
      switch (type) {
        case P2PFrameType.HELLO: {
          const hello = JSON.parse(payload.toString('utf8')) as {
            token: string
            sessionId: string
            resume?: boolean
          }
          sessionId = hello.sessionId
          resumeMode = hello.resume === true
          tokenValid = opts.validateToken(hello.token, resumeMode)
          if (!tokenValid) {
            await writeFrame(socket, P2PFrameType.ERROR, encodeError('TRANSFER_DENIED', '无效 token'))
            socket.end()
          } else {
            opts.onSocket?.(sessionId, socket)
          }
          break
        }
        case P2PFrameType.MANIFEST: {
          if (!tokenValid) return
          manifest = JSON.parse(payload.toString('utf8')) as P2PManifest
          // 续传：统计各文件临时文件（.tmp）在磁盘上已有的字节数，通过 DECISION 返回给上传端
          if (resumeMode) {
            for (const f of manifest.files) {
              try {
                const { tmp } = resolveTarget(f)
                const info = await stat(tmp)
                offsets.set(f.id, Math.max(0, Math.min(info.size, f.size)))
              } catch {
                offsets.set(f.id, 0)
              }
            }
            // 已有字节计入进度基线，与上传端显示一致
            let base = 0
            for (const v of offsets.values()) base += v
            received += base
            opts.onProgress?.(received, manifest.totalSize, sessionId)
          }
          const first = manifest.files[0]
          const acceptedResult = await opts.requestConfirm({
            fileName: first?.path ?? '',
            fileCount: manifest.files.length,
            totalSize: manifest.totalSize,
            sessionId,
            resume: resumeMode
          })
          accepted = acceptedResult
          if (!accepted) {
            await writeFrame(socket, P2PFrameType.DECISION, encodeDecision(false, '用户拒绝'))
            socket.end()
            return
          }
          await writeFrame(
            socket,
            P2PFrameType.DECISION,
            Buffer.from(
              JSON.stringify({
                accepted: true,
                resume: resumeMode,
                offsets: Object.fromEntries(offsets)
              }),
              'utf8'
            )
          )
          break
        }
        case P2PFrameType.CHUNK: {
          if (!manifest || !accepted) return
          // v2 CHUNK：fileId(4) + offset(BigUInt64) + data
          const fileId = payload.readUInt32BE(0)
          const offset = Number(payload.readBigUInt64BE(4))
          const data = payload.subarray(12)
          let fh = writers.get(fileId)
          if (!fh) {
            const file = manifest.files.find((f) => f.id === fileId)
            if (!file) return
            const { abs, tmp } = resolveTarget(file)
            await mkdir(path.dirname(abs), { recursive: true })
            // 先写临时文件 .tmp，全部接收完成后再更名为正式名称；
            // 续传且已有部分数据时以 r+ 打开（保留已收内容）；否则 w 截断重写
            const startOff = resumeMode ? (offsets.get(fileId) ?? 0) : 0
            fh = await open(tmp, startOff > 0 ? 'r+' : 'w')
            writers.set(fileId, fh)
          }
          await fh.write(data, 0, data.length, offset)
          received += data.length
          opts.onProgress?.(received, manifest.totalSize, sessionId)
          if (!socket.destroyed) {
            // v2 ACK：fileId(4) + offset(BigUInt64) + length(4)
            const ack = Buffer.alloc(16)
            ack.writeUInt32BE(fileId, 0)
            ack.writeBigUInt64BE(BigInt(offset), 4)
            ack.writeUInt32BE(data.length, 12)
            await writeFrame(socket, P2PFrameType.ACK, ack).catch(() => {})
          }
          break
        }
        case P2PFrameType.DONE: {
          doneReceived = true
          for (const fh of writers.values()) await fh.close()
          writers.clear()
          await finalizeFiles()
          opts.onDone?.(sessionId)
          socket.end()
          break
        }
        case P2PFrameType.ERROR: {
          const e = JSON.parse(payload.toString('utf8')) as { message: string }
          socket.destroy(new Error(e.message))
          break
        }
        default:
          break
      }
    }
  }) as P2PReceiveServer
  server.markCancelled = (sessionId: string): void => {
    cancelledSessions.add(sessionId)
  }
  return server
}

export function newSessionId(): string {
  return randomUUID()
}
