import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { resolveSafePath, resolveRealPathWithinRoot, toRelative } from '@shared/path-safety'
import {
  Permission,
  hasPermission,
  resolvePermission,
  type PermissionNode
} from '@shared/permissions'
import type { FileEntry, ServerEvent, TransferRequestEvent } from '@shared/protocol'

export interface TransferServerConfig {
  p2pPort: number
  confirmTimeoutMs: number
  autoAccept: boolean
}

export class PermissionChecker {
  constructor(private roots: Map<string, { root: string; nodes: PermissionNode[] }>) {}

  rootFor(rootPath: string): { root: string; nodes: PermissionNode[] } | undefined {
    return this.roots.get(rootPath)
  }

  resolve(rootPath: string, relPath: string): number {
    const g = this.roots.get(rootPath)
    if (!g) return 0
    return resolvePermission(g.nodes, relPath)
  }

  require(rootPath: string, relPath: string, need: number): void {
    const mask = this.resolve(rootPath, relPath)
    if (!hasPermission(mask, need)) {
      throw Object.assign(new Error('权限不足'), { code: 'FORBIDDEN' as const })
    }
  }
}

function toEntry(base: string, full: string, stats: fs.Stats): FileEntry {
  return {
    name: path.basename(full),
    path: toRelative(base, full),
    type: stats.isDirectory() ? 'dir' : 'file',
    size: stats.size,
    mtime: Math.floor(stats.mtimeMs),
    isSymlink: stats.isSymbolicLink()
  }
}

const MAX_READ_BYTES = 8 * 1024 * 1024

export class FileOps {
  constructor(private checker: PermissionChecker) {}

  private root(rootPath: string): { root: string; nodes: PermissionNode[] } {
    const g = this.checker.rootFor(rootPath)
    if (!g) throw Object.assign(new Error('未知根目录'), { code: 'FORBIDDEN' as const })
    return g
  }

  /** 解析到根目录内的绝对路径（静态防护） */
  private abs(rootPath: string, relPath: string): string {
    const g = this.root(rootPath)
    return resolveSafePath(g.root, relPath)
  }

  /** 对已存在路径做符号链接逃逸校验 */
  private real(rootPath: string, absolute: string): string {
    const g = this.root(rootPath)
    return resolveRealPathWithinRoot(g.root, absolute)
  }

  /** 解析目标保存位置的绝对路径（供传输记录展示，不做存在性校验） */
  resolvePath(rootPath: string, relPath: string): string {
    return this.abs(rootPath, relPath)
  }

  async list(rootPath: string, relPath: string): Promise<FileEntry[]> {
    this.checker.require(rootPath, relPath, Permission.READ)
    const g = this.root(rootPath)
    const dirReal = this.real(rootPath, this.abs(rootPath, relPath))
    const dirents = await fsp.readdir(dirReal, { withFileTypes: true })
    const entries: FileEntry[] = []
    for (const d of dirents) {
      const full = path.join(dirReal, d.name)
      try {
        entries.push(toEntry(g.root, full, await fsp.lstat(full)))
      } catch {
        /* 跳过无法访问项 */
      }
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return entries
  }

  async stat(rootPath: string, relPath: string): Promise<FileEntry> {
    this.checker.require(rootPath, relPath, Permission.READ)
    const g = this.root(rootPath)
    const real = this.real(rootPath, this.abs(rootPath, relPath))
    return toEntry(g.root, real, await fsp.lstat(real))
  }

  async mkdir(rootPath: string, relPath: string): Promise<void> {
    this.checker.require(rootPath, relPath, Permission.WRITE)
    await fsp.mkdir(this.abs(rootPath, relPath), { recursive: true })
  }

  async rename(rootPath: string, relPath: string, newName: string): Promise<void> {
    this.checker.require(rootPath, relPath, Permission.RENAME)
    if (!newName || /[\\/]|\.\./.test(newName)) {
      throw Object.assign(new Error('非法文件名'), { code: 'BAD_REQUEST' as const })
    }
    const abs = this.real(rootPath, this.abs(rootPath, relPath))
    const target = path.join(path.dirname(abs), newName)
    await fsp.rename(abs, target)
  }

  async remove(rootPath: string, relPath: string, recursive = false): Promise<void> {
    this.checker.require(rootPath, relPath, Permission.DELETE)
    if (!relPath || relPath === '.' || relPath === '/') {
      throw Object.assign(new Error('不允许删除根目录'), { code: 'BAD_REQUEST' as const })
    }
    const abs = this.real(rootPath, this.abs(rootPath, relPath))
    const st = await fsp.lstat(abs)
    // 非空目录必须显式声明递归删除
    if (st.isDirectory() && !recursive) {
      const children = await fsp.readdir(abs)
      if (children.length > 0) {
        throw Object.assign(new Error('目录非空，需递归删除'), { code: 'CONFLICT' as const })
      }
    }
    await fsp.rm(abs, { recursive: true, force: false })
  }

  async readFile(rootPath: string, relPath: string): Promise<{ data: string; size: number }> {
    this.checker.require(rootPath, relPath, Permission.READ)
    const abs = this.real(rootPath, this.abs(rootPath, relPath))
    const st = await fsp.stat(abs)
    if (st.size > MAX_READ_BYTES) {
      throw Object.assign(new Error('文件过大，请使用传输功能'), { code: 'BAD_REQUEST' as const })
    }
    const buf = await fsp.readFile(abs)
    return { data: buf.toString('base64'), size: buf.length }
  }

  /** P2P 上传前收集文件（目录递归展开，符号链接不跟随）；要求 TRANSFER + DOWNLOAD 权限（对方从本机下载） */
  async collectForTransfer(rootPath: string, relPath: string): Promise<Array<{ absPath: string; relPath: string }>> {
    this.checker.require(rootPath, relPath, Permission.TRANSFER)
    this.checker.require(rootPath, relPath, Permission.DOWNLOAD)
    const g = this.root(rootPath)
    const start = this.real(rootPath, this.abs(rootPath, relPath))
    const base = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const out: Array<{ absPath: string; relPath: string }> = []
    const walk = async (abs: string, rel: string): Promise<void> => {
      const st = await fsp.lstat(abs)
      if (st.isDirectory()) {
        for (const c of await fsp.readdir(abs)) {
          await walk(path.join(abs, c), rel ? `${rel}/${c}` : c)
        }
      } else if (st.isFile()) {
        out.push({ absPath: abs, relPath: rel })
      }
    }
    await walk(start, base)
    return out
  }

  async writeFile(rootPath: string, relPath: string, base64: string): Promise<void> {
    this.checker.require(rootPath, relPath, Permission.WRITE)
    const abs = this.abs(rootPath, relPath)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, Buffer.from(base64, 'base64'))
  }

  async createUpload(rootPath: string, relPath: string): Promise<{ uploadId: string }> {
    this.checker.require(rootPath, relPath, Permission.UPLOAD)
    const abs = this.abs(rootPath, relPath)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    const id = randomUUID()
    // 直接写正式文件名（不经过临时文件），分块按偏移落盘
    const handle = await fsp.open(abs, 'w')
    uploadTable.set(id, { path: abs, handle })
    return { uploadId: id }
  }

  async appendUpload(uploadId: string, offset: number, base64: string): Promise<void> {
    const u = uploadTable.get(uploadId)
    if (!u) throw Object.assign(new Error('未知上传'), { code: 'NOT_FOUND' as const })
    const buf = Buffer.from(base64, 'base64')
    await u.handle.write(buf, 0, buf.length, offset)
  }

  /** 接收完成：关闭句柄（数据已直接写入正式文件） */
  async finishUpload(uploadId: string): Promise<void> {
    const u = uploadTable.get(uploadId)
    if (!u) throw Object.assign(new Error('未知上传'), { code: 'NOT_FOUND' as const })
    uploadTable.delete(uploadId)
    await u.handle.close()
  }

  /** 取消上传：关闭句柄（已写入的部分数据保留在正式文件，可断点续传） */
  async abortUpload(uploadId: string): Promise<void> {
    const u = uploadTable.get(uploadId)
    if (!u) return
    uploadTable.delete(uploadId)
    try {
      await u.handle.close()
    } catch {
      /* ignore */
    }
  }
}

export interface UploadState {
  path: string
  handle: fsp.FileHandle
}

const uploadTable = new Map<string, UploadState>()

/** 下载确认管理器 */
export class TransferManager {
  private pending = new Map<
    string,
    { info: TransferRequestEvent; resolve: (accepted: boolean) => void }
  >()

  constructor(
    private config: TransferServerConfig,
    private emit: (ev: ServerEvent) => void
  ) {}

  /** 运行时热更新配置（如切换自动下载），立即对后续传输生效 */
  update(patch: Partial<TransferServerConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  request(info: Omit<TransferRequestEvent, 'expiresAt'>): Promise<boolean> {
    if (this.config.autoAccept) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const expiresAt = Date.now() + this.config.confirmTimeoutMs
      const full: TransferRequestEvent = { ...info, expiresAt }
      this.pending.set(info.sessionId, { info: full, resolve })
      this.emit({ event: 'transfer:incoming', data: full })
      setTimeout(() => {
        const p = this.pending.get(info.sessionId)
        if (p) {
          this.pending.delete(info.sessionId)
          p.resolve(false)
        }
      }, this.config.confirmTimeoutMs)
    })
  }

  decide(sessionId: string, accept: boolean): boolean {
    const p = this.pending.get(sessionId)
    if (!p) return false
    this.pending.delete(sessionId)
    p.resolve(accept)
    return true
  }

  listPending(): TransferRequestEvent[] {
    return Array.from(this.pending.values()).map((p) => p.info)
  }
}
