import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../main/server/db'
import { LatticeServer } from '../main/server/service'
import { ConnectionManager } from '../main/client/manager'
import { maskFromNames } from '@shared/permissions'

let root: string
let server: LatticeServer
let manager: ConnectionManager
let db: ReturnType<typeof openDatabase>
const PORT = 47401

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'lattice-multi-'))
  const shared = path.join(root, 'share')
  mkdirSync(shared)
  db = openDatabase(path.join(root, 's.db'))
  server = new LatticeServer(db, {
    wsPort: PORT,
    p2pPort: PORT + 1,
    confirmTimeoutMs: 3000,
    autoAccept: true,
    lockAfter: 5,
    lockMs: 60000
  })
  for (const u of ['u1', 'u2']) {
    const id = server.accountRepo.create(u, 'pw')
    server.accountRepo.addGrant(id, shared, 'share', maskFromNames(['READ']))
  }
  await server.start()
  manager = new ConnectionManager(
    () => {},
    () => {}
  )
})

afterAll(async () => {
  await manager.disconnectAll()
  await server.stop()
  // Windows 下必须先关库再删目录，否则 SQLite 文件被占用（EPERM）
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('多连接管理器', () => {
  it('可同时建立两个独立连接', async () => {
    const a = await manager.connect({ host: '127.0.0.1', port: PORT, username: 'u1', password: 'pw' })
    const b = await manager.connect({ host: '127.0.0.1', port: PORT, username: 'u2', password: 'pw' })
    expect(a.id).not.toBe(b.id)
    expect(manager.list().length).toBe(2)

    // 各自请求互不干扰
    const ra = await manager.request<{ entries: unknown[] }>(a.id, 'list', {
      root: b.login!.grants[0].root,
      path: ''
    })
    expect(Array.isArray(ra.entries)).toBe(true)

    await manager.disconnect(a.id)
    expect(manager.list().length).toBe(1)
    // 剩余连接仍可用
    const rb = await manager.request<{ entries: unknown[] }>(b.id, 'list', {
      root: b.login!.grants[0].root,
      path: ''
    })
    expect(Array.isArray(rb.entries)).toBe(true)
  })

  it('闭合连接后请求失败', async () => {
    const c = await manager.connect({ host: '127.0.0.1', port: PORT, username: 'u1', password: 'pw' })
    await manager.disconnect(c.id)
    await expect(manager.request(c.id, 'list', {})).rejects.toThrow()
  })
})
