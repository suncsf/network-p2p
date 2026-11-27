import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../main/server/db'
import { LatticeServer } from '../main/server/service'
import { LatticeClient } from '../main/client/client'
import { sendFiles, encodeChunk } from '../main/p2p/transfer'
import { maskFromNames } from '@shared/permissions'
import type { TransferGrantResult } from '@shared/protocol'

let root: string
let sharedA: string
let sharedB: string
let server: LatticeServer
let client: LatticeClient
let db: ReturnType<typeof openDatabase>
const WS_PORT = 47301
const P2P_PORT = 47302

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'lattice-p2p-'))
  sharedA = path.join(root, 'a')
  sharedB = path.join(root, 'b')
  mkdirSync(sharedA)
  mkdirSync(sharedB)
  writeFileSync(path.join(sharedA, 'from-a.txt'), 'content-from-a-peer')

  db = openDatabase(path.join(root, 'srv.db'))
  server = new LatticeServer(db, {
    wsPort: WS_PORT,
    p2pPort: P2P_PORT,
    confirmTimeoutMs: 5000,
    autoAccept: true, // 自动接受，便于测试
    lockAfter: 5,
    lockMs: 60000
  })
  const accId = server.accountRepo.create('bob', 'pw123456')
  server.accountRepo.addGrant(
    accId,
    sharedA,
    'A',
    maskFromNames(['READ', 'WRITE', 'UPLOAD', 'DOWNLOAD', 'TRANSFER'])
  )
  server.accountRepo.addGrant(
    accId,
    sharedB,
    'B',
    maskFromNames(['READ', 'WRITE', 'UPLOAD', 'DOWNLOAD', 'TRANSFER'])
  )
  await server.start()

  client = new LatticeClient(
    () => {},
    () => {}
  )
  await client.connect({ host: '127.0.0.1', port: WS_PORT, username: 'bob', password: 'pw123456' })
})

afterAll(async () => {
  await client.disconnect()
  await server.stop()
  // Windows 下必须先关库再删目录，否则 SQLite 文件被占用（EPERM）
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('P2P 端到端（授权 + 动态目录 + 自动接收）', () => {
  it('CHUNK 偏移量支持 >4GB（v2 BigUInt64 编码，回归：UInt32 在 4G 越界中断）', () => {
    const bigOffset = 2 ** 32 + 65536 // 4GB + 64KB
    const buf = encodeChunk(1, bigOffset, Buffer.alloc(8, 1))
    expect(buf.readUInt32BE(0)).toBe(1)
    expect(Number(buf.readBigUInt64BE(4))).toBe(bigOffset)
    expect(buf.length).toBe(20)
  })

  it('通过 transferGrant 后接收端写入授权目录', async () => {
    // 1) 向服务端申请接收授权（目标是 sharedB）
    const grant = await client.request<TransferGrantResult>('transferGrant', {
      root: sharedB,
      path: '',
      direction: 'receive'
    })
    expect(grant.p2pToken).toBeTruthy()
    expect(grant.port).toBe(P2P_PORT)

    // 2) 以该 token 通过 P2P 发送到服务端接收端口
    const srcFile = path.join(sharedA, 'from-a.txt')
    await sendFiles({
      host: '127.0.0.1',
      port: grant.port,
      token: grant.p2pToken,
      sessionId: grant.sessionId,
      files: [{ id: 1, absPath: srcFile, relPath: 'incoming/from-a.txt' }]
    })
    await new Promise((r) => setTimeout(r, 400))

    const dest = path.join(sharedB, 'incoming', 'from-a.txt')
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe('content-from-a-peer')
  })

  it('p2pPush 大文件（>8MB）经 P2P 直连落盘', async () => {
    const bigSize = 12 * 1024 * 1024
    writeFileSync(path.join(sharedA, 'big.bin'), Buffer.alloc(bigSize, 7))

    // 1) 申请本机接收授权（目标是 sharedB）
    const grant = await client.request<TransferGrantResult>('transferGrant', {
      root: sharedB,
      path: '',
      direction: 'receive'
    })

    // 2) 命令服务端把 big.bin 从磁盘直推到接收端口（数据不经 WS 命令通道）
    const r = await client.request<{ fileCount: number }>('p2pPush', {
      root: sharedA,
      path: 'big.bin',
      host: '127.0.0.1',
      port: grant.port,
      p2pToken: grant.p2pToken,
      sessionId: grant.sessionId
    })
    expect(r.fileCount).toBe(1)

    const dest = path.join(sharedB, 'big.bin')
    let size = -1
    for (let i = 0; i < 100; i++) {
      if (existsSync(dest)) {
        size = statSync(dest).size
        if (size === bigSize) break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(existsSync(dest)).toBe(true)
    expect(size).toBe(bigSize)
  })

  it('p2pPush 中断后断点续传（接收端返回偏移，仅补发剩余部分）', async () => {
    const bigSize = 12 * 1024 * 1024
    writeFileSync(path.join(sharedA, 'resumable.bin'), Buffer.alloc(bigSize, 9))
    const dest = path.join(sharedB, 'resumable.bin')

    // 1) 发起推送，等接收端写入部分数据后模拟中断（销毁接收 socket）
    const grant = await client.request<TransferGrantResult>('transferGrant', {
      root: sharedB,
      path: '',
      direction: 'receive'
    })
    await client.request<{ fileCount: number }>('p2pPush', {
      root: sharedA,
      path: 'resumable.bin',
      host: '127.0.0.1',
      port: grant.port,
      p2pToken: grant.p2pToken,
      sessionId: grant.sessionId
    })
    let partial = 0
    for (let i = 0; i < 2000; i++) {
      if (existsSync(dest)) {
        partial = statSync(dest).size
        if (partial > 512 * 1024) break
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(partial).toBeGreaterThan(0)
    server.abortReceive(grant.sessionId)
    // 等发送端感知断开并停止写入
    await new Promise((r) => setTimeout(r, 400))
    partial = statSync(dest).size
    expect(partial).toBeLessThan(bigSize)

    // 2) 续传：以原 sessionId 重建接收授权，resume 推送应从断点继续
    const grant2 = server.createLocalTransferGrant(sharedB, { token: grant.sessionId })
    expect(grant2.sessionId).toBe(grant.sessionId)
    await client.request<{ fileCount: number }>('p2pPush', {
      root: sharedA,
      path: 'resumable.bin',
      host: '127.0.0.1',
      port: grant2.port,
      p2pToken: grant2.p2pToken,
      sessionId: grant2.sessionId,
      resume: true
    })
    let size = -1
    for (let i = 0; i < 100; i++) {
      if (existsSync(dest)) {
        size = statSync(dest).size
        if (size === bigSize) break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(size).toBe(bigSize)
  })
})
