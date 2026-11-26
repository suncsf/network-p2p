import type { Db } from './server/db'

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        remember INTEGER NOT NULL DEFAULT 0,
        last_used INTEGER NOT NULL,
        UNIQUE(host, port, username)
      );

      CREATE TABLE IF NOT EXISTS window_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        peer TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        remote_path TEXT NOT NULL DEFAULT '',
        local_path TEXT NOT NULL DEFAULT '',
        total INTEGER NOT NULL DEFAULT 0,
        transferred INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'active',
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        resume TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_transfers_state ON transfers(state);
      CREATE INDEX IF NOT EXISTS idx_transfers_session ON transfers(session_id);
    `
  }
]

export class LocalStore {
  constructor(private db: Db) {
    this.db.pragma('journal_mode = WAL')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS local_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
    )
    const row = this.db
      .prepare("SELECT value FROM local_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined
    const current = row ? Number(row.value) : 0
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue
      this.db.exec(m.sql)
      this.db
        .prepare(
          "INSERT INTO local_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(String(m.version))
    }
  }

  /** 底层数据库连接（供传输记录等模块复用同一 local.db） */
  get database(): Db {
    return this.db
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO app_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, JSON.stringify(value))
  }

  listConnections(): Array<{ id: number; host: string; port: number; username: string; lastUsed: number }> {
    const rows = this.db
      .prepare('SELECT * FROM connections ORDER BY last_used DESC')
      .all() as Array<{ id: number; host: string; port: number; username: string; last_used: number }>
    return rows.map((r) => ({
      id: r.id,
      host: r.host,
      port: r.port,
      username: r.username,
      lastUsed: r.last_used
    }))
  }

  saveConnection(host: string, port: number, username: string): void {
    this.db
      .prepare(
        'INSERT INTO connections (host, port, username, last_used) VALUES (?,?,?,?) ' +
          'ON CONFLICT(host, port, username) DO UPDATE SET last_used = excluded.last_used'
      )
      .run(host, port, username, Date.now())
  }

  removeConnection(id: number): void {
    this.db.prepare('DELETE FROM connections WHERE id = ?').run(id)
  }

  getWindowState(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM window_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.value)
    } catch {
      return undefined
    }
  }

  setWindowState(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO window_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, JSON.stringify(value))
  }
}
