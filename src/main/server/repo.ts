import type { Db } from './db'
import { hashPassword } from './auth'
import { Permission, normalizeNodePath, type PermissionNode } from '@shared/permissions'
import type { FileRootGrant as ProtoGrant } from '@shared/protocol'
import type { AccountView, GrantView, AuditRow } from '@shared/models'

export interface AccountRecord {
  id: number
  username: string
  enabled: number
  is_admin: number
  failed_attempts: number
  locked_until: number
  created_at: number
  password_salt: string
  password_hash: string
}

export interface GrantRecord {
  id: number
  account_id: number
  root_path: string
  label: string
  default_mask: number
  created_at: number
}

export type { AccountView, GrantView } from '@shared/models'

export class AccountRepo {
  constructor(private db: Db) {}

  list(): AccountView[] {
    const accounts = this.db
      .prepare('SELECT * FROM accounts ORDER BY id ASC')
      .all() as AccountRecord[]
    return accounts.map((a) => this.toView(a))
  }

  findByName(username: string): AccountRecord | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) as
      | AccountRecord
      | undefined
  }

  findById(id: number): AccountRecord | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | AccountRecord
      | undefined
  }

  create(username: string, password: string, isAdmin = false): number {
    const { salt, hash } = hashPassword(password)
    const info = this.db
      .prepare(
        'INSERT INTO accounts (username, password_salt, password_hash, enabled, is_admin, created_at) VALUES (?,?,?,?,?,?)'
      )
      .run(username, salt, hash, 1, isAdmin ? 1 : 0, Date.now())
    return Number(info.lastInsertRowid)
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }

  setPassword(id: number, password: string): void {
    const { salt, hash } = hashPassword(password)
    this.db
      .prepare(
        'UPDATE accounts SET password_salt = ?, password_hash = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?'
      )
      .run(salt, hash, id)
  }

  setEnabled(id: number, enabled: boolean): void {
    this.db.prepare('UPDATE accounts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  recordFailure(id: number, lockAfter: number, lockMs: number): void {
    const acc = this.findById(id)
    if (!acc) return
    const attempts = acc.failed_attempts + 1
    const lockedUntil = attempts >= lockAfter ? Date.now() + lockMs : 0
    this.db
      .prepare('UPDATE accounts SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(attempts, lockedUntil, id)
  }

  clearFailures(id: number): void {
    this.db
      .prepare('UPDATE accounts SET failed_attempts = 0, locked_until = 0 WHERE id = ?')
      .run(id)
  }

  /* ------------------------- 授权目录 ------------------------- */

  addGrant(
    accountId: number,
    rootPath: string,
    label: string,
    defaultMask: number = Permission.READ
  ): number {
    const info = this.db
      .prepare(
        'INSERT INTO grants (account_id, root_path, label, default_mask, created_at) VALUES (?,?,?,?,?)'
      )
      .run(accountId, rootPath, label, defaultMask, Date.now())
    const grantId = Number(info.lastInsertRowid)
    // 根节点默认权限
    this.db
      .prepare(
        'INSERT INTO permission_nodes (grant_id, rel_path, inherit, mask) VALUES (?,?,?,?)'
      )
      .run(grantId, '.', 0, defaultMask)
    return grantId
  }

  removeGrant(grantId: number): void {
    this.db.prepare('DELETE FROM grants WHERE id = ?').run(grantId)
  }

  listGrants(accountId: number): GrantRecord[] {
    return this.db
      .prepare('SELECT * FROM grants WHERE account_id = ?')
      .all(accountId) as GrantRecord[]
  }

  getGrant(grantId: number): GrantRecord | undefined {
    return this.db.prepare('SELECT * FROM grants WHERE id = ?').get(grantId) as
      | GrantRecord
      | undefined
  }

  setNode(grantId: number, relPath: string, inherit: boolean, mask: number): void {
    const p = normalizeNodePath(relPath)
    this.db
      .prepare(
        'INSERT INTO permission_nodes (grant_id, rel_path, inherit, mask) VALUES (?,?,?,?) ' +
          'ON CONFLICT(grant_id, rel_path) DO UPDATE SET inherit = excluded.inherit, mask = excluded.mask'
      )
      .run(grantId, p, inherit ? 1 : 0, mask)
  }

  removeNode(grantId: number, relPath: string): void {
    const p = normalizeNodePath(relPath)
    if (p === '.') return
    this.db
      .prepare('DELETE FROM permission_nodes WHERE grant_id = ? AND rel_path = ?')
      .run(grantId, p)
  }

  getNodes(grantId: number): PermissionNode[] {
    const rows = this.db
      .prepare('SELECT rel_path, inherit, mask FROM permission_nodes WHERE grant_id = ?')
      .all(grantId) as Array<{ rel_path: string; inherit: number; mask: number }>
    return rows.map((r) => ({ path: r.rel_path, inherit: r.inherit === 1, mask: r.mask }))
  }

  /* ------------------------- 下发给客户端 ------------------------- */

  protocolGrants(accountId: number): ProtoGrant[] {
    return this.listGrants(accountId).map((g): ProtoGrant => ({
      root: g.root_path,
      label: g.label,
      nodes: this.getNodes(g.id)
    }))
  }

  toView(a: AccountRecord): AccountView {
    return {
      id: a.id,
      username: a.username,
      enabled: a.enabled === 1,
      isAdmin: a.is_admin === 1,
      lockedUntil: a.locked_until,
      createdAt: a.created_at,
      grants: this.listGrants(a.id).map((g) => ({
        id: g.id,
        rootPath: g.root_path,
        label: g.label,
        defaultMask: g.default_mask,
        nodes: this.getNodes(g.id)
      }))
    }
  }
}

export class AuditRepo {
  constructor(private db: Db) {}

  log(actor: string | null, action: string, detail?: unknown): void {
    this.db
      .prepare('INSERT INTO audit_log (ts, actor, action, detail) VALUES (?,?,?,?)')
      .run(Date.now(), actor, action, detail === undefined ? null : JSON.stringify(detail))
  }

  list(limit = 200): AuditRow[] {
    return this.db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(limit) as AuditRow[]
  }
}

export class SettingsRepo {
  constructor(private db: Db) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO server_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, JSON.stringify(value))
  }
}
