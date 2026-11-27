import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from './server/db'
import { LocalStore } from './store'
import { LatticeServer } from './server/service'
import { ConnectionManager } from './client/manager'
import { TransferStore } from './transfers'
import { TransferRunner, applyRemoteTransferProgress } from './transfer-runner'
import { maskFromNames } from '@shared/permissions'
import type { TransferRecord } from '@shared/protocol'

// 双端环境：远端服务器 A（文件提供方 / 上传接收方）+ 本机接收端 B（自己的服务端 + TransferRunner）
let root: string
let sharedA: string  // 远端 A 的授权目录
let recvDir: string  // 本机接收目录
let localSrc: string // 本机上传源目录

let serverA: LatticeServer
let serverB: LatticeServer
let storeA: TransferStore
let storeB: TransferStore
let runnerA: TransferRunner
let runnerB: TransferRunner
let conns: ConnectionManager
let connId = ''
let dbA: ReturnType<typeof openDatabase>
let dbB: ReturnType<typeof openDatabase>

const A_WS = 47501
const A_P2P = 47502
const B_WS = 47511
const B_P2P = 47512

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 等待文件达到指定大小 */
async function waitSize(p: string, pred: (n: number) => boolean, tries = 3000): Promise<number> {
  for (let i = 0; i < tries; i++) {
    try {
      const n = statSync(p).size
      if (pred(n)) return n
    } catch { /* not yet */ }
    await wait(5)
  }
  try { return statSync(p).size } catch { return -1 }
}

/** 等待最终文件出现且达到指定大小（接收端在传输完成后才把 .tmp 更名为正式文件） */
async function waitFinal(p: string, size: number, tries = 3000): Promise<void> {
  await waitSize(p, (n) => n === size, tries)
  expect(statSync(p).size).toBe(size)
}

async function waitState(store: TransferStore, id: number, states: string[], tries = 3000): Promise<TransferRecord> {
  for (let i = 0; i < tries; i++) {
    const rec = store.get(id)
    if (rec && states.includes(rec.state)) return rec
    await wait(5)
  }
  const rec = store.get(id)
  throw new Error(`记录 ${id} 状态等待超时：${rec?.state} ${rec?.error}`)
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'lattice-resume-'))
  sharedA = path.join(root, 'remote-share')
  recvDir = path.join(root, 'local-recv')
  localSrc = path.join(root, 'local-src')
  mkdirSync(sharedA)
  mkdirSync(recvDir)
  mkdirSync(localSrc)

  // 远端 A：准备待下载文件
  writeFileSync(path.join(sharedA, 'single.bin'), Buffer.alloc(12 * 1024 * 1024, 1))
  writeFileSync(path.join(sharedA, 'push-src.bin'), Buffer.alloc(12 * 1024 * 1024, 6))
  mkdirSync(path.join(sharedA, 'photos'))
  writeFileSync(path.join(sharedA, 'photos', 'a.jpg'), Buffer.alloc(6 * 1024 * 1024, 2))
  writeFileSync(path.join(sharedA, 'photos', 'b.jpg'), Buffer.alloc(6 * 1024 * 1024, 3))
  writeFileSync(path.join(sharedA, 'notes.txt'), Buffer.alloc(4 * 1024 * 1024, 4))

  // 与生产同构：先跑 local.db 迁移建 transfers 表，再挂传输记录存储
  dbA = openDatabase(path.join(root, 'a.db'))
  new LocalStore(dbA)
  storeA = new TransferStore(dbA)
  serverA = new LatticeServer(dbA, {
    wsPort: A_WS, p2pPort: A_P2P, confirmTimeoutMs: 3000, autoAccept: true, lockAfter: 5, lockMs: 60000
  }, storeA)
  const accA = serverA.accountRepo.create('alice', 'pw123456')
  serverA.accountRepo.addGrant(accA, sharedA, 'share', maskFromNames(['READ', 'WRITE', 'UPLOAD', 'DOWNLOAD', 'TRANSFER']))
  await serverA.start()

  // 本机 B：接收端自己的服务端 + 传输存储 + 执行器
  dbB = openDatabase(path.join(root, 'b.db'))
  new LocalStore(dbB)
  storeB = new TransferStore(dbB)
  serverB = new LatticeServer(dbB, {
    wsPort: B_WS, p2pPort: B_P2P, confirmTimeoutMs: 3000, autoAccept: true, lockAfter: 5, lockMs: 60000
  }, storeB)
  await serverB.start()

  // 与生产 index.ts 一致：把远端服务端广播的 transfer:progress 同步到本机记录
  conns = new ConnectionManager(() => {}, (_connId, ev) => {
    if (ev.event === 'transfer:progress') {
      applyRemoteTransferProgress(
        storeB,
        runnerB,
        ev.data as { sessionId?: string; cancelled?: boolean; failed?: boolean; reason?: string; paused?: boolean }
      )
    }
  })
  const info = await conns.connect({ host: '127.0.0.1', port: A_WS, username: 'alice', password: 'pw123456' })
  connId = info.id

  runnerB = new TransferRunner(storeB, conns, serverB)
  runnerA = new TransferRunner(storeA, conns, serverA)
})

afterAll(async () => {
  await conns.disconnectAll()
  await serverA.stop()
  await serverB.stop()
  dbA.close()
  dbB.close()
  rmSync(root, { recursive: true, force: true })
})

describe('断点续传回归（TransferRunner 真实流程）', () => {
  it('S1: 上传中断后续传（断开工作区连接 → 重连 → resume）', async () => {
    const src = path.join(localSrc, 'up.bin')
    writeFileSync(src, Buffer.alloc(12 * 1024 * 1024, 5))
    const rec = runnerB.startUpload({
      connId, root: sharedA, path: 'up.bin', filePath: src, name: 'up.bin', size: 12 * 1024 * 1024
    })
    // 等远端出现部分临时文件（接收端先写 .tmp，完成后更名）后断开连接模拟中断
    const remote = path.join(sharedA, 'up.bin')
    await waitSize(remote + '.tmp', (n) => n > 512 * 1024)
    await conns.disconnect(connId)
    const interrupted = await waitState(storeB, rec.id, ['interrupted', 'cancelled', 'completed'])
    expect(interrupted.state).toBe('interrupted')

    // 重连（新连接 id）后 resume
    const info2 = await conns.connect({ host: '127.0.0.1', port: A_WS, username: 'alice', password: 'pw123456' })
    connId = info2.id
    await runnerB.resume(rec.id)
    const done = await waitState(storeB, rec.id, ['completed', 'interrupted'])
    expect(done.state).toBe('completed')
    expect(statSync(remote).size).toBe(12 * 1024 * 1024)
  })

  it('S2: 单文件下载（带 rename）中断后续传', async () => {
    // 模拟 prepareReceive：本机接收授权 + p2p-recv 记录
    const grant = serverB.createLocalTransferGrant(recvDir)
    const dest = path.join(recvDir, 'saved.bin')
    const rec = storeB.create({
      kind: 'p2p-recv',
      peer: 'alice',
      name: 'saved.bin',
      remotePath: 'single.bin',
      localPath: dest,
      total: 12 * 1024 * 1024,
      state: 'active',
      sessionId: grant.sessionId,
      resume: JSON.stringify({
        connId, host: '127.0.0.1', port: A_WS, username: 'alice',
        root: sharedA, path: 'single.bin', dir: recvDir, rename: 'saved.bin', isDir: false, name: 'single.bin'
      })
    })
    // 发起推送（对端确认后开始），等部分落盘后中断
    await conns.request(connId, 'p2pPush', {
      root: sharedA, path: 'single.bin',
      host: grant.host, port: grant.port, p2pToken: grant.p2pToken, sessionId: grant.sessionId,
      rename: 'saved.bin'
    })
    await waitSize(dest + '.tmp', (n) => n > 512 * 1024)
    // 模拟网络中断：发送端停止推送（非用户取消，接收端保留 .tmp 断点）
    serverA.cancelPush(grant.sessionId, '模拟中断')
    await wait(500)
    const interrupted = await waitState(storeB, rec.id, ['interrupted'])
    expect(interrupted.state).toBe('interrupted')

    // 续传（与 TransferRunner.resume 的 p2p-recv 分支一致）
    await runnerB.resume(rec.id)
    const done = await waitState(storeB, rec.id, ['completed', 'interrupted', 'cancelled'])
    expect(done.state).toBe('completed')
    await waitFinal(dest, 12 * 1024 * 1024)
  })

  it('S3: 批量下载（paths 多路径）中断后续传', async () => {
    const grant = serverB.createLocalTransferGrant(recvDir)
    // 批量下载记录：修复后 prepareReceive 会把完整 paths 存入续传上下文
    const rec = storeB.create({
      kind: 'p2p-recv',
      peer: 'alice',
      name: '2 个项目',
      remotePath: 'photos',
      localPath: recvDir,
      total: 16 * 1024 * 1024,
      state: 'active',
      sessionId: grant.sessionId,
      resume: JSON.stringify({
        connId, host: '127.0.0.1', port: A_WS, username: 'alice',
        root: sharedA, path: 'photos', paths: ['photos', 'notes.txt'],
        dir: recvDir, rename: undefined, isDir: true, name: 'photos'
      })
    })
    // 原始推送是 paths 多路径（photos + notes.txt），与 FilesView.downloadSelected 一致
    await conns.request(connId, 'p2pPush', {
      root: sharedA, paths: ['photos', 'notes.txt'],
      host: grant.host, port: grant.port, p2pToken: grant.p2pToken, sessionId: grant.sessionId
    })
    await waitSize(path.join(recvDir, 'photos', 'a.jpg') + '.tmp', (n) => n > 512 * 1024)
    // 模拟网络中断：发送端停止推送（非用户取消，接收端保留 .tmp 断点）
    serverA.cancelPush(grant.sessionId, '模拟中断')
    await wait(500)
    await waitState(storeB, rec.id, ['interrupted'])

    // 续传
    await runnerB.resume(rec.id)
    const done = await waitState(storeB, rec.id, ['completed', 'interrupted', 'cancelled'])
    expect(done.state).toBe('completed')
    await waitFinal(path.join(recvDir, 'photos', 'a.jpg'), 6 * 1024 * 1024)
    await waitFinal(path.join(recvDir, 'photos', 'b.jpg'), 6 * 1024 * 1024)
    await waitFinal(path.join(recvDir, 'notes.txt'), 4 * 1024 * 1024)
  })

  it('S7: 单选批量下载（paths 只有一项）后发送端续传（回归：修复前抛「非法路径」）', async () => {
    // 回归：downloadSelected 只勾选 1 项 → p2pPush 只带 paths:['single.bin']。
    // 修复前发送端记录 ctx 的 path/paths 均为空，续传时 collectTargets 收到 [undefined]，
    // resolveSafePath(root, undefined) 抛 PathViolationError「非法路径」。
    const grantB = serverB.createLocalTransferGrant(recvDir)
    const dest = path.join(recvDir, 's7.bin')
    const sessionId = grantB.sessionId
    await conns.request(connId, 'p2pPush', {
      root: sharedA, paths: ['single.bin'],
      host: grantB.host, port: grantB.port, p2pToken: grantB.p2pToken, sessionId,
      rename: 's7.bin'
    })
    await waitSize(dest + '.tmp', (n) => n > 512 * 1024)
    // 模拟网络中断：发送端停止推送（非用户取消，接收端保留 .tmp 断点）
    serverA.cancelPush(sessionId, '模拟中断')
    await wait(500)
    const sendRecs = storeA.getBySession(sessionId).filter((r) => r.kind === 'p2p-send')
    expect(sendRecs.length).toBe(1)
    // 修复后：发送端记录的续传上下文始终保留完整 targets
    const ctx = JSON.parse(storeA.getResume(sendRecs[0].id) ?? '{}') as { path?: string; paths?: string[] }
    expect(ctx.paths).toEqual(['single.bin'])
    // 续传成功（接收端异步落盘更名，轮询等待最终文件）
    await runnerA.resume(sendRecs[0].id)
    await waitState(storeA, sendRecs[0].id, ['completed', 'interrupted', 'cancelled'])
    await waitFinal(dest, 12 * 1024 * 1024)
  })

  it('S5: 对端主动推送的接收记录（resume 上下文只有 dir）续传', async () => {
    // 对端推送场景：本机记录由 createRecvRecord 补建，resume 上下文只有 { dir }
    const grantB = serverB.createLocalTransferGrant(recvDir)
    const dest = path.join(recvDir, 'push-src.bin')
    await conns.request(connId, 'p2pPush', {
      root: sharedA, path: 'push-src.bin',
      host: grantB.host, port: grantB.port, p2pToken: grantB.p2pToken, sessionId: grantB.sessionId
    })
    await waitSize(dest + '.tmp', (n) => n > 512 * 1024)
    // 模拟网络中断：发送端停止推送
    serverA.cancelPush(grantB.sessionId, '模拟中断')
    await wait(500)
    // 本机 createRecvRecord 补建的记录（resume 上下文只有 dir）
    const rec = storeB.create({
      kind: 'p2p-recv',
      peer: 'alice',
      name: 'push-src.bin',
      remotePath: 'push-src.bin',
      localPath: recvDir,
      total: 12 * 1024 * 1024,
      state: 'interrupted',
      sessionId: grantB.sessionId,
      resume: JSON.stringify({ dir: recvDir })
    })
    // 续传：本机没有对端 root/paths，无法重放推送，应明确报错（而非「权限不足」等误导信息）
    await expect(runnerB.resume(rec.id)).rejects.toThrow(/对端路径信息|对端.*续传/)
    expect(storeB.get(rec.id)?.state).toBe('interrupted')
  })

  it('S6: 发送端面板续传 p2p-send 记录（resumePush）', async () => {
    // 发送端视角：A 服务端推送 push-src.bin 到本机 B，中断后从 A 侧续传
    const grantB = serverB.createLocalTransferGrant(recvDir)
    const dest = path.join(recvDir, 'push-src2.bin')
    const sessionId = grantB.sessionId
    await conns.request(connId, 'p2pPush', {
      root: sharedA, path: 'push-src.bin',
      host: grantB.host, port: grantB.port, p2pToken: grantB.p2pToken, sessionId,
      rename: 'push-src2.bin'
    })
    await waitSize(dest + '.tmp', (n) => n > 512 * 1024)
    // 模拟网络中断：发送端停止推送（非用户取消，接收端保留 .tmp 断点）
    serverA.cancelPush(sessionId, '模拟中断')
    await wait(500)
    // A 侧应有一条 p2p-send 记录（storeA），状态 cancelled（发送端侧停止=本端取消，仍可续传）
    const sendRecs = storeA.getBySession(sessionId).filter((r) => r.kind === 'p2p-send')
    expect(sendRecs.length).toBe(1)
    expect(sendRecs[0].state).toBe('cancelled')
    // A 侧 runner 执行续传
    await runnerA.resume(sendRecs[0].id)
    await waitState(storeA, sendRecs[0].id, ['completed', 'interrupted', 'cancelled'])
    await waitFinal(dest, 12 * 1024 * 1024)
  })

  it('S8: 接收端暂停后继续（挂起对端推送，原会话恢复）', async () => {
    // 大文件保证暂停时仍在传输中
    const big = Buffer.alloc(48 * 1024 * 1024, 7)
    writeFileSync(path.join(sharedA, 'pause-src.bin'), big)
    const grant = serverB.createLocalTransferGrant(recvDir)
    const dest = path.join(recvDir, 'pause-resume.bin')
    const rec = storeB.create({
      kind: 'p2p-recv',
      peer: 'alice',
      name: 'pause-resume.bin',
      remotePath: 'single.bin',
      localPath: dest,
      total: big.length,
      state: 'active',
      sessionId: grant.sessionId,
      resume: JSON.stringify({
        connId, host: '127.0.0.1', port: A_WS, username: 'alice',
        root: sharedA, path: 'pause-src.bin', dir: recvDir,
        rename: 'pause-resume.bin', isDir: false, name: 'pause-src.bin'
      })
    })
    await conns.request(connId, 'p2pPush', {
      root: sharedA, path: 'pause-src.bin',
      host: grant.host, port: grant.port, p2pToken: grant.p2pToken, sessionId: grant.sessionId,
      rename: 'pause-resume.bin'
    })
    await waitSize(dest + '.tmp', (n) => n > 1024 * 1024)
    await runnerB.pause(rec.id)
    const paused = await waitState(storeB, rec.id, ['paused'])
    expect(paused.state).toBe('paused')
    // 暂停同步：发送端的上传记录也进入「已暂停」（p2pPushPause 同步对端记录）
    const sendRec = storeA.getBySession(grant.sessionId).find((r) => r.kind === 'p2p-send')
    expect(sendRec).toBeDefined()
    const sendPaused = await waitState(storeA, sendRec!.id, ['paused', 'completed'])
    expect(sendPaused.state).toBe('paused')
    // 暂停后落盘停止增长（发送端挂起，socket 保留）；先等 TCP 在途分块落盘稳定，部分数据在 .tmp
    let frozen = 0
    for (let i = 0; i < 200; i++) {
      await wait(50)
      const cur = statSync(dest + '.tmp').size
      if (cur === frozen) break
      frozen = cur
    }
    await wait(700)
    expect(statSync(dest + '.tmp').size).toBe(frozen)
    // 继续 → 原地恢复 → 完成
    await runnerB.resume(rec.id)
    const done = await waitState(storeB, rec.id, ['completed', 'interrupted', 'cancelled'])
    expect(done.state).toBe('completed')
    await waitFinal(dest, big.length)
    // 恢复同步：发送端记录回到进行中并最终完成
    const sendDone = await waitState(storeA, sendRec!.id, ['completed', 'interrupted', 'cancelled'])
    expect(sendDone.state).toBe('completed')
  })

  it('S9: 上传暂停后继续（挂起分块循环，上传会话保留免重初始化）', async () => {
    const big = Buffer.alloc(48 * 1024 * 1024, 8)
    const src = path.join(localSrc, 'pause-up.bin')
    writeFileSync(src, big)
    const rec = runnerB.startUpload({
      connId, root: sharedA, path: 'pause-up.bin', filePath: src, name: 'pause-up.bin', size: big.length
    })
    const remote = path.join(sharedA, 'pause-up.bin')
    await waitSize(remote + '.tmp', (n) => n > 1024 * 1024)
    await runnerB.pause(rec.id)
    const paused = await waitState(storeB, rec.id, ['paused'])
    expect(paused.state).toBe('paused')
    // 暂停后远端落盘停止增长（接收端先写 .tmp 临时文件）；先等最后一个在途分块落盘
    let frozen = 0
    for (let i = 0; i < 200; i++) {
      await wait(50)
      const cur = statSync(remote + '.tmp').size
      if (cur === frozen) break
      frozen = cur
    }
    await wait(700)
    expect(statSync(remote + '.tmp').size).toBe(frozen)
    // 继续 → 完成
    await runnerB.resume(rec.id)
    const done = await waitState(storeB, rec.id, ['completed', 'interrupted'])
    expect(done.state).toBe('completed')
    expect(statSync(remote).size).toBe(big.length)
  })

  it('S10: 发送端暂停后接收端记录同步暂停，恢复后同步回进行中', async () => {
    const big = Buffer.alloc(48 * 1024 * 1024, 9)
    writeFileSync(path.join(sharedA, 'pause-sync.bin'), big)
    const grant = serverB.createLocalTransferGrant(recvDir)
    const dest = path.join(recvDir, 'pause-sync.bin')
    const rec = storeB.create({
      kind: 'p2p-recv',
      peer: 'alice',
      name: 'pause-sync.bin',
      remotePath: 'pause-sync.bin',
      localPath: dest,
      total: big.length,
      state: 'active',
      sessionId: grant.sessionId,
      resume: JSON.stringify({
        connId, host: '127.0.0.1', port: A_WS, username: 'alice',
        root: sharedA, path: 'pause-sync.bin', dir: recvDir,
        rename: 'pause-sync.bin', isDir: false, name: 'pause-sync.bin'
      })
    })
    await conns.request(connId, 'p2pPush', {
      root: sharedA, path: 'pause-sync.bin',
      host: grant.host, port: grant.port, p2pToken: grant.p2pToken, sessionId: grant.sessionId,
      rename: 'pause-sync.bin'
    })
    const sendRec = storeA.getBySession(grant.sessionId).find((r) => r.kind === 'p2p-send')
    expect(sendRec).toBeDefined()
    await waitSize(dest + '.tmp', (n) => n > 1024 * 1024)
    // 发送端暂停 → 本机记录暂停 + 广播 → 接收端记录经广播同步为「已暂停」
    await runnerA!.pause(sendRec!.id)
    expect((await waitState(storeA, sendRec!.id, ['paused'])).state).toBe('paused')
    expect((await waitState(storeB, rec.id, ['paused'])).state).toBe('paused')
    // 发送端恢复 → 接收端记录同步回「进行中」，直至完成
    await runnerA!.resume(sendRec!.id)
    await waitState(storeB, rec.id, ['active', 'completed'])
    const done = await waitState(storeB, rec.id, ['completed', 'interrupted', 'cancelled'])
    expect(done.state).toBe('completed')
    await waitFinal(dest, big.length)
  })
})
