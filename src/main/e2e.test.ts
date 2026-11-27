import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../main/server/db'
import { LatticeServer } from '../main/server/service'
import { LatticeClient } from '../main/client/client'
import { sendFiles, createReceiveServer } from '../main/p2p/transfer'
import { Permission, maskFromNames } from '@shared/permissions'

let root: string
let dbFile: string
let shared: string
let server: LatticeServer
let client: LatticeClient
let login: import('@shared/protocol').LoginResult
let db: ReturnType<typeof openDatabase>
const WS_PORT = 47201
const P2P_PORT = 47202

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'lattice-e2e-'))
  shared = path.join(root, 'share')
  mkdirSync(shared)
  writeFileSync(path.join(shared, 'hello.txt'), 'hello lattice')
  mkdirSync(path.join(shared, 'docs'))

  dbFile = path.join(root, 'server.db')
  db = openDatabase(dbFile)
  server = new LatticeServer(db, {
    wsPort: WS_PORT,
    p2pPort: P2P_PORT,
    confirmTimeoutMs: 3000,
    autoAccept: true,
    lockAfter: 5,
    lockMs: 60000
  })

  const accId = server.accountRepo.create('alice', 'secret123')
  server.accountRepo.addGrant(
    accId,
    shared,
    'share',
    maskFromNames(['READ', 'WRITE', 'RENAME', 'DELETE', 'UPLOAD', 'DOWNLOAD', 'TRANSFER'])
  )
  // 子目录权限覆盖：docs 只读
  const grants = server.accountRepo.listGrants(accId)
  server.accountRepo.setNode(grants[0].id, 'docs', false, Permission.READ)

  await server.start()

  client = new LatticeClient(
    () => {},
    () => {}
  )
  login = await client.connect({
    host: '127.0.0.1',
    port: WS_PORT,
    username: 'alice',
    password: 'secret123'
  })
})

afterAll(async () => {
  try {
    await client.disconnect()
  } catch {
    /* ignore */
  }
  await server.stop()
  // Windows 下必须先关库再删目录，否则 SQLite 文件被占用（EPERM）
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('鉴权', () => {
  it('登录成功并下发授权目录', () => {
    expect(login.token).toBeTruthy()
    expect(login.grants.length).toBe(1)
    expect(login.grants[0].root).toBe(shared)
  })

  it('错误密码被拒绝', async () => {
    const c = new LatticeClient(() => {}, () => {})
    await expect(
      c.connect({ host: '127.0.0.1', port: WS_PORT, username: 'alice', password: 'wrong' })
    ).rejects.toThrow()
  })
})

describe('文件操作与权限', () => {
  it('列出根目录', async () => {
    const r = await client.request<{ entries: Array<{ name: string }> }>('list', { root: shared, path: '' })
    const names = r.entries.map((e) => e.name)
    expect(names).toContain('hello.txt')
    expect(names).toContain('docs')
  })

  it('有读权限可读取文件', async () => {
    const r = await client.request<{ data: string }>('readFile', { root: shared, path: 'hello.txt' })
    expect(Buffer.from(r.data, 'base64').toString()).toBe('hello lattice')
  })

  it('无写权限目录写入被拒绝', async () => {
    await expect(
      client.request('writeFile', { root: shared, path: 'docs/deny.txt', data: Buffer.from('x').toString('base64') })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('有权限目录可写入', async () => {
    await client.request('writeFile', { root: shared, path: 'ok.txt', data: Buffer.from('ok').toString('base64') })
    expect(existsSync(path.join(shared, 'ok.txt'))).toBe(true)
  })

  it('路径穿越被拒绝', async () => {
    await expect(
      client.request('list', { root: shared, path: '../../etc' })
    ).rejects.toMatchObject({ code: 'PATH_VIOLATION' })
  })

  it('新建与重命名', async () => {
    await client.request('mkdir', { root: shared, path: 'newdir' })
    expect(existsSync(path.join(shared, 'newdir'))).toBe(true)
    await client.request('rename', { root: shared, path: 'ok.txt', newName: 'ok2.txt' })
    expect(existsSync(path.join(shared, 'ok2.txt'))).toBe(true)
  })

  it('删除', async () => {
    await client.request('delete', { root: shared, path: 'newdir' })
    expect(existsSync(path.join(shared, 'newdir'))).toBe(false)
  })
})

describe('P2P 传输', () => {
  it('接收端自动接并落盘', async () => {
    const dest = path.join(root, 'received')
    mkdirSync(dest)
    const recv = createReceiveServer({
      baseDir: dest,
      validateToken: (t) => t === 'good-token',
      requestConfirm: async () => true
    })
    await new Promise<void>((r) => recv.listen(P2P_PORT + 10, '127.0.0.1', () => r()))

    try {
      const srcFile = path.join(root, 'src.txt')
      writeFileSync(srcFile, 'p2p-content-12345')
      await sendFiles({
        host: '127.0.0.1',
        port: P2P_PORT + 10,
        token: 'good-token',
        sessionId: 's1',
        files: [{ id: 1, absPath: srcFile, relPath: 'sub/src.txt' }]
      })
      // 等待接收端写完
      await new Promise((r) => setTimeout(r, 300))
      const received = path.join(dest, 'sub', 'src.txt')
      expect(existsSync(received)).toBe(true)
      expect(readFileSync(received, 'utf8')).toBe('p2p-content-12345')
    } finally {
      await new Promise<void>((r) => recv.close(() => r()))
    }
  })

  it('无效 token 被拒绝', async () => {
    const dest = path.join(root, 'received2')
    mkdirSync(dest)
    const recv = createReceiveServer({
      baseDir: dest,
      validateToken: () => false,
      requestConfirm: async () => true
    })
    await new Promise<void>((r) => recv.listen(P2P_PORT + 20, '127.0.0.1', () => r()))
    try {
      const srcFile = path.join(root, 'src2.txt')
      writeFileSync(srcFile, 'x')
      await expect(
        sendFiles({
          host: '127.0.0.1',
          port: P2P_PORT + 20,
          token: 'bad',
          sessionId: 's2',
          files: [{ id: 1, absPath: srcFile, relPath: 'src2.txt' }]
        })
      ).rejects.toThrow()
    } finally {
      await new Promise<void>((r) => recv.close(() => r()))
    }
  })
})
