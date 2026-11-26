import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from './server/db'
import { LocalStore } from './store'
import { TransferStore } from './transfers'
import type { TransferRecord } from '@shared/protocol'

let dir: string
let store: TransferStore

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lattice-tstore-'))
  const local = new LocalStore(openDatabase(path.join(dir, 'local.db')))
  store = new TransferStore(local.database)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('TransferStore', () => {
  it('创建记录并读回全部字段', () => {
    const rec = store.create({
      kind: 'upload',
      peer: 'bob',
      name: 'a.bin',
      remotePath: 'dir/a.bin',
      localPath: '/tmp/a.bin',
      total: 1024,
      state: 'active',
      sessionId: 's-1',
      resume: '{"offset":0}'
    })
    expect(rec.id).toBeGreaterThan(0)
    const got = store.get(rec.id)
    expect(got).toMatchObject({
      kind: 'upload',
      peer: 'bob',
      name: 'a.bin',
      remotePath: 'dir/a.bin',
      localPath: '/tmp/a.bin',
      total: 1024,
      transferred: 0,
      state: 'active',
      sessionId: 's-1'
    } satisfies Partial<TransferRecord>)
    expect(got?.createdAt).toBeGreaterThan(0)
    expect(got?.updatedAt).toBeGreaterThan(0)
  })

  it('update / updateProgress 生效并触发 onChange', () => {
    const onChange = vi.fn()
    store.onChange = onChange
    const rec = store.create({ kind: 'p2p-recv', peer: 'alice', name: 'x', total: 100 })
    onChange.mockClear()

    store.updateProgress(rec.id, 40)
    expect(store.get(rec.id)?.transferred).toBe(40)
    store.update(rec.id, { state: 'interrupted', error: '连接中断' })
    const after = store.get(rec.id)
    expect(after?.state).toBe('interrupted')
    expect(after?.error).toBe('连接中断')
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('list 支持按状态过滤、getBySession 关联收发两条记录', () => {
    store.create({ kind: 'p2p-send', peer: 'a', name: 'f', sessionId: 'same', state: 'active' })
    store.create({ kind: 'p2p-recv', peer: 'b', name: 'f', sessionId: 'same', state: 'active' })
    store.create({ kind: 'upload', peer: 'c', name: 'g', state: 'completed' })

    expect(store.getBySession('same')).toHaveLength(2)
    expect(store.getBySession('same').map((r) => r.kind).sort()).toEqual(['p2p-recv', 'p2p-send'])
    expect(store.list('completed')).toHaveLength(1)
    expect(store.list()).toHaveLength(3)
  })

  it('interruptAll 只影响进行中的记录', () => {
    const a = store.create({ kind: 'upload', peer: 'a', name: 'a', state: 'active' })
    const b = store.create({ kind: 'p2p-recv', peer: 'b', name: 'b', state: 'completed' })
    store.interruptAll()
    expect(store.get(a.id)?.state).toBe('interrupted')
    expect(store.get(b.id)?.state).toBe('completed')
  })

  it('clearFinished 清除已完成与已取消，保留已中断', () => {
    store.create({ kind: 'upload', peer: 'a', name: 'a', state: 'completed' })
    store.create({ kind: 'upload', peer: 'b', name: 'b', state: 'cancelled' })
    const keep = store.create({ kind: 'p2p-recv', peer: 'c', name: 'c', state: 'interrupted' })
    const n = store.clearFinished()
    expect(n).toBe(2)
    expect(store.list()).toHaveLength(1)
    expect(store.get(keep.id)?.state).toBe('interrupted')
  })

  it('remove 删除单条记录', () => {
    const rec = store.create({ kind: 'upload', peer: 'a', name: 'a', state: 'cancelled' })
    store.remove(rec.id)
    expect(store.get(rec.id)).toBeUndefined()
  })
})
