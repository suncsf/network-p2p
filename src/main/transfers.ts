import type { Db } from './server/db'
import type { TransferKind, TransferRecord, TransferState } from '@shared/protocol'

/** 创建传输记录时的可选项（未传字段用默认值） */
export interface TransferRecordInput {
  kind: TransferKind
  peer: string
  name: string
  remotePath?: string
  localPath?: string
  total?: number
  transferred?: number
  state?: TransferState
  error?: string | null
  sessionId?: string
  /** 断点续传所需上下文（JSON 字符串，仅主进程使用） */
  resume?: string | null
}

type UpdatePatch = Partial<{
  state: TransferState
  error: string | null
  transferred: number
  total: number
  name: string
  peer: string
  sessionId: string
  resume: string | null
}>

interface Row {
  id: number
  kind: string
  peer: string
  name: string
  remote_path: string
  local_path: string
  total: number
  transferred: number
  state: string
  error: string | null
  created_at: number
  updated_at: number
  session_id: string
  resume: string | null
}

function mapRow(r: Row): TransferRecord {
  return {
    id: r.id,
    kind: r.kind as TransferKind,
    peer: r.peer,
    name: r.name,
    remotePath: r.remote_path,
    localPath: r.local_path,
    total: r.total,
    transferred: r.transferred,
    state: r.state as TransferState,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sessionId: r.session_id
  }
}

/**
 * 传输记录存储层（local.db transfers 表）。
 * 任何写操作都会触发 onChange，主进程借此把最新记录推给渲染层（transfer:updated）。
 */
export class TransferStore {
  /** 记录变化回调（由 index.ts 注入，用于向渲染层广播） */
  onChange?: (rec: TransferRecord) => void

  constructor(private db: Db) {}

  private mapRowSafe(r: Row | undefined): TransferRecord | undefined {
    return r ? mapRow(r) : undefined
  }

  create(input: TransferRecordInput): TransferRecord {
    const now = Date.now()
    const info = this.db
      .prepare(
        `INSERT INTO transfers
          (kind, peer, name, remote_path, local_path, total, transferred, state, error, created_at, updated_at, session_id, resume)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.kind,
        input.peer ?? '',
        input.name ?? '',
        input.remotePath ?? '',
        input.localPath ?? '',
        input.total ?? 0,
        input.transferred ?? 0,
        input.state ?? 'active',
        input.error ?? null,
        now,
        now,
        input.sessionId ?? '',
        input.resume ?? null
      )
    const rec = this.get(Number(info.lastInsertRowid))
    if (!rec) throw new Error('传输记录创建失败')
    this.onChange?.(rec)
    return rec
  }

  get(id: number): TransferRecord | undefined {
    const r = this.db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as Row | undefined
    return this.mapRowSafe(r)
  }

  /** 读取断点续传上下文（主进程内部使用，不下发渲染层） */
  getResume(id: number): string | null {
    const r = this.db.prepare('SELECT resume FROM transfers WHERE id = ?').get(id) as
      | { resume: string | null }
      | undefined
    return r?.resume ?? null
  }

  getBySession(sessionId: string): TransferRecord[] {
    if (!sessionId) return []
    const rows = this.db.prepare('SELECT * FROM transfers WHERE session_id = ?').all(sessionId) as Row[]
    return rows.map(mapRow)
  }

  /** state 不传返回全部，按更新时间倒序 */
  list(state?: TransferState): TransferRecord[] {
    const rows = (
      state
        ? this.db.prepare('SELECT * FROM transfers WHERE state = ? ORDER BY updated_at DESC').all(state)
        : this.db.prepare('SELECT * FROM transfers ORDER BY updated_at DESC').all()
    ) as Row[]
    return rows.map(mapRow)
  }

  update(id: number, patch: UpdatePatch): void {
    const sets: string[] = []
    const vals: unknown[] = []
    const col: Record<string, string> = {
      state: 'state',
      error: 'error',
      transferred: 'transferred',
      total: 'total',
      name: 'name',
      peer: 'peer',
      sessionId: 'session_id',
      resume: 'resume'
    }
    for (const [k, v] of Object.entries(patch)) {
      const c = col[k]
      if (!c) continue
      sets.push(`${c} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    vals.push(Date.now(), id)
    this.db.prepare(`UPDATE transfers SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    const rec = this.get(id)
    if (rec) this.onChange?.(rec)
  }

  /** 进度更新（调用方负责节流） */
  updateProgress(id: number, transferred: number, total?: number): void {
    if (total !== undefined) {
      this.db
        .prepare('UPDATE transfers SET transferred = ?, total = ?, updated_at = ? WHERE id = ?')
        .run(transferred, total, Date.now(), id)
    } else {
      this.db
        .prepare('UPDATE transfers SET transferred = ?, updated_at = ? WHERE id = ?')
        .run(transferred, Date.now(), id)
    }
    const rec = this.get(id)
    if (rec) this.onChange?.(rec)
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM transfers WHERE id = ?').run(id)
  }

  /** 清除已结束的记录（已完成 + 已取消）；已中断保留（可续传） */
  clearFinished(): number {
    const info = this.db
      .prepare("DELETE FROM transfers WHERE state IN ('completed', 'cancelled')")
      .run()
    return info.changes
  }

  /** 应用启动时调用：上次退出时仍在进行中的传输标记为已中断（保留现场，可续传） */
  interruptAll(): void {
    this.db
      .prepare(
        "UPDATE transfers SET state = 'interrupted', error = ?, updated_at = ? WHERE state = 'active'"
      )
      .run('应用退出导致中断', Date.now())
  }
}
