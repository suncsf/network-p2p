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
    // 部分数据写在临时文件 .tmp 里，完成后才更名为正式文件；
    // 回环传输极快（可能几十毫秒完成），用 setImmediate 高频采样捕捉中间状态
    const destTmp = dest + '.tmp'
    for (let i = 0; i < 50000; i++) {
      try {
        const n = statSync(destTmp).size
        if (n > 512 * 1024) {
          partial = n
          break
        }
      } catch {
        /* 临时文件尚未创建（或已完成更名） */
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(partial).toBeGreaterThan(0)
    // 模拟网络中断：从发送端侧停止推送（接收端非「用户取消」，保留 .tmp 以便断点续传）
    server.cancelPush(grant.sessionId, '模拟中断')
    // 等发送端感知断开并停止写入
    await new Promise((r) => setTimeout(r, 400))
    // 网络中断保留 .tmp 可续传；若中断前数据已全部进入接收队列，tmp 可能已写到完整大小（尚未更名）
    partial = existsSync(destTmp) ? statSync(destTmp).size : statSync(dest).size
    expect(partial).toBeGreaterThan(0)

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

describe('接收策略确认（autoAccept=false：未确认必须拒绝，不能直接落盘）', () => {
  const WS2 = 47311
  const P2P2 = 47312
  let srv: LatticeServer
  let cli: LatticeClient
  let db2: ReturnType<typeof openDatabase>
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lattice-confirm-'))
    db2 = openDatabase(path.join(dir, 'srv.db'))
    srv = new LatticeServer(db2, {
      wsPort: WS2,
      p2pPort: P2P2,
      confirmTimeoutMs: 400, // 短超时：测试快速走「确认超时 → 拒绝」路径
      autoAccept: false,
      lockAfter: 5,
      lockMs: 60000
    })
    const accId = srv.accountRepo.create('carol', 'pw123456')
    srv.accountRepo.addGrant(
      accId,
      dir,
      'C',
      maskFromNames(['READ', 'WRITE', 'UPLOAD', 'DOWNLOAD', 'TRANSFER'])
    )
    await srv.start()
    cli = new LatticeClient(
      () => {},
      () => {}
    )
    await cli.connect({ host: '127.0.0.1', port: WS2, username: 'carol', password: 'pw123456' })
  })

  afterAll(async () => {
    await cli.disconnect()
    await srv.stop()
    db2.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('WS 上传 uploadInit 未确认被拒（FORBIDDEN），不落盘', async () => {
    await expect(
      cli.request('uploadInit', { root: dir, path: 'no-confirm.bin', size: 10 })
    ).rejects.toThrow(/拒绝|超时|FORBIDDEN/)
    expect(existsSync(path.join(dir, 'no-confirm.bin'))).toBe(false)
  })

  it('接收方向 transferGrant 未确认被拒（FORBIDDEN），不发 token', async () => {
    await expect(
      cli.request<TransferGrantResult>('transferGrant', {
        root: dir,
        path: '',
        direction: 'receive',
        fileName: 'x.bin',
        fileCount: 1,
        totalSize: 10
      })
    ).rejects.toThrow(/拒绝|超时|FORBIDDEN/)
  })

  it('下载方向 transferGrant（send）不经过接收确认，正常发 token', async () => {
    const grant = await cli.request<TransferGrantResult>('transferGrant', {
      root: dir,
      path: '',
      direction: 'send'
    })
    expect(grant.p2pToken).toBeTruthy()
  })
})
