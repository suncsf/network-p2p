import http from 'node:http'
import { networkInterfaces } from 'node:os'
import type { LocalNic, ProbeResult } from '@shared/protocol'

function ipToInt(ip: string): number {
  const parts = ip.split('.').map((n) => Number(n))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`非法 IP 地址：${ip}`)
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

/** 点分十进制掩码 → 前缀位数（如 255.255.255.0 → 24）；解析失败按 /24 兜底 */
function maskBits(mask: string): number {
  try {
    const n = ipToInt(mask)
    let bits = 0
    for (let i = 31; i >= 0; i--) {
      if ((n >>> i) & 1) bits++
      else break
    }
    return bits || 24
  } catch {
    return 24
  }
}

function maskFromBits(bits: number): number {
  return bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0)
}

/** 识别本机 IPv4 网卡（排除回环），并推导所在网段 CIDR */
export function localNics(): LocalNic[] {
  const out: LocalNic[] = []
  const ifaces = networkInterfaces()
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue
      const bits = maskBits(i.netmask)
      const network = (ipToInt(i.address) & maskFromBits(bits)) >>> 0
      out.push({ name, address: i.address, netmask: i.netmask, cidr: `${intToIp(network)}/${bits}` })
    }
  }
  return out
}

/**
 * 展开网段内待探测的主机地址（去掉网络地址/广播地址/本机地址）。
 * 掩码比 /24 更宽（如 /16）时收敛到地址所在 /24，避免一次探测数千个地址拖垮界面。
 */
export function expandRange(cidr: string, max = 254): string[] {
  const [addr, bitsStr] = cidr.split('/')
  const bits = Math.min(Number(bitsStr) || 24, 24)
  const self = ipToInt(addr)
  const network = (self & maskFromBits(bits)) >>> 0
  const size = 2 ** (32 - bits)
  const first = network + 1
  const last = network + size - 2
  const out: string[] = []
  for (let n = first; n <= last && out.length < max; n++) {
    if (n === self) continue
    out.push(intToIp(n))
  }
  return out
}

/**
 * 探测单个主机：向服务端默认端口发 HTTP 请求，
 * 只有收到服务端返回的确认数据（service === 'v-lattice'）才算「可连接」，
 * 端口开放但服务不匹配的同样判为不可连接。
 */
export function probeHost(host: string, port: number, timeoutMs = 1200): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false
    const req = http.get({ host, port, path: '/probe', timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (d: Buffer) => {
        body += d.toString('utf8')
        if (body.length > 4096) res.destroy()
      })
      res.on('end', () => {
        try {
          const info = JSON.parse(body) as { service?: string; hostname?: string; protocolVersion?: number }
          if (info.service === 'v-lattice') {
            finish({
              host,
              port,
              alive: true,
              service: {
                name: info.service,
                hostname: info.hostname ?? '',
                protocolVersion: info.protocolVersion ?? 1
              }
            })
          } else {
            finish({ host, port, alive: false, error: '端口开放但不是 V-Lattice 服务' })
          }
        } catch {
          finish({ host, port, alive: false, error: '端口开放但响应异常' })
        }
      })
      res.on('error', () => finish({ host, port, alive: false, error: '读取响应失败' }))
    })
    function finish(r: ProbeResult): void {
      if (settled) return
      settled = true
      req.destroy()
      resolve(r)
    }
    req.on('timeout', () => finish({ host, port, alive: false, error: '连接超时' }))
    req.on('error', (e: NodeJS.ErrnoException) =>
      finish({ host, port, alive: false, error: e.code === 'ECONNREFUSED' ? '端口未开放' : '无法连接' })
    )
  })
}

/**
 * 探测整个网段：并发分批执行（每批 32 个），单 IP 失败不影响其他。
 * 返回顺序与网段展开顺序一致，便于 UI 展示。
 */
export async function probeRange(cidr: string, port: number, timeoutMs?: number): Promise<ProbeResult[]> {
  const hosts = expandRange(cidr)
  const out: ProbeResult[] = []
  const BATCH = 32
  for (let i = 0; i < hosts.length; i += BATCH) {
    const batch = hosts.slice(i, i + BATCH)
    out.push(...(await Promise.all(batch.map((h) => probeHost(h, port, timeoutMs)))))
  }
  return out
}
