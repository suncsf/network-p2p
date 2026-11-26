import { describe, it, expect, vi } from 'vitest'
import { TransferManager } from './server/fs-ops'

describe('TransferManager 配置热更新', () => {
  it('update 后 autoAccept 立即生效', async () => {
    const emit = vi.fn()
    const tm = new TransferManager({ p2pPort: 1, confirmTimeoutMs: 200, autoAccept: false }, emit)

    // autoAccept=false：进入待确认，广播事件等待人工决定
    const p1 = tm.request({ sessionId: 's1', from: 'a', fileName: 'f.txt', fileCount: 1, totalSize: 1 })
    expect(emit).toHaveBeenCalledTimes(1)
    tm.decide('s1', true)
    await expect(p1).resolves.toBe(true)

    // 运行时切换为自动接收：新请求立即通过（无需 decide）
    tm.update({ autoAccept: true })
    await expect(
      tm.request({ sessionId: 's2', from: 'a', fileName: 'f.txt', fileCount: 1, totalSize: 1 })
    ).resolves.toBe(true)

    // 再切回需确认：重新进入待确认
    tm.update({ autoAccept: false })
    const p3 = tm.request({ sessionId: 's3', from: 'a', fileName: 'f.txt', fileCount: 1, totalSize: 1 })
    expect(emit).toHaveBeenCalledTimes(2)
    tm.decide('s3', false)
    await expect(p3).resolves.toBe(false)
  })
})
