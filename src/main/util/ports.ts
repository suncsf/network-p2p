import net from 'node:net'

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '0.0.0.0')
  })
}

/** 从 start 开始向上查找空闲端口 */
export async function getFreePort(start: number, max = 200): Promise<number> {
  for (let p = start; p < start + max && p <= 65535; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error('未找到可用端口')
}
