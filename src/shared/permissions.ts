/** 权限位定义（位掩码） */
export const Permission = {
  NONE: 0,
  READ: 1 << 0,
  WRITE: 1 << 1,
  RENAME: 1 << 2,
  DELETE: 1 << 3,
  UPLOAD: 1 << 4,
  DOWNLOAD: 1 << 5,
  TRANSFER: 1 << 6
} as const

export type PermissionName = keyof typeof Permission
export type PermissionMask = number

/** 所有权限位组成的完整掩码 */
export const PERMISSION_ALL: PermissionMask =
  Permission.READ |
  Permission.WRITE |
  Permission.RENAME |
  Permission.DELETE |
  Permission.UPLOAD |
  Permission.DOWNLOAD |
  Permission.TRANSFER

export const PERMISSION_LABELS: Record<string, string> = {
  READ: '读取',
  WRITE: '写入',
  RENAME: '重命名',
  DELETE: '删除',
  UPLOAD: '上传',
  DOWNLOAD: '下载',
  TRANSFER: '传输(P2P)'
}

export const PERMISSION_ORDER: string[] = [
  'READ',
  'WRITE',
  'RENAME',
  'DELETE',
  'UPLOAD',
  'DOWNLOAD',
  'TRANSFER'
]

/** 单个权限树节点（服务端存储 / 下发给客户端） */
export interface PermissionNode {
  /** 相对白名单根目录的路径，根为 "." 或 "" */
  path: string
  /** 是否继承父级权限 */
  inherit: boolean
  /** 当 inherit 为 false 时生效的权限位 */
  mask: PermissionMask
}

export interface DirectoryGrant {
  /** 白名单根目录的绝对路径 */
  root: string
  /** 该根目录下的权限树节点 */
  nodes: PermissionNode[]
}

export function maskFromNames(names: readonly string[]): PermissionMask {
  let mask = 0
  for (const n of names) {
    const v = (Permission as Record<string, number>)[n]
    if (typeof v === 'number') mask |= v
  }
  return mask
}

export function maskToNames(mask: PermissionMask): string[] {
  return PERMISSION_ORDER.filter((n) => (mask & Permission[n as PermissionName]) !== 0)
}

export function hasPermission(mask: PermissionMask, perm: PermissionMask): boolean {
  return (mask & perm) === perm
}

/** 规范化节点的相对路径：统一分隔符、去掉前后多余分隔符 */
export function normalizeNodePath(p: string): string {
  let s = (p ?? '').replace(/\\/g, '/').trim()
  if (s === '' || s === '.' || s === './') return '.'
  s = s.replace(/\/+/g, '/')
  s = s.replace(/^\.\//, '')
  s = s.replace(/^\/+/, '')
  s = s.replace(/\/$/, '')
  return s === '' ? '.' : s
}

/**
 * 计算指定相对路径在权限树中的有效权限。
 * 规则：从根开始，向下遍历祖先链；每个节点若 inherit=false 则以其 mask 覆盖当前权限，
 * 若 inherit=true 则保留父级权限。最深的显式覆盖生效。
 */
export function resolvePermission(nodes: PermissionNode[], relativePath: string): PermissionMask {
  const target = normalizeNodePath(relativePath)
  const byPath = new Map<string, PermissionNode>()
  for (const n of nodes) byPath.set(normalizeNodePath(n.path), n)

  const segments = target === '.' ? [] : target.split('/')
  const chain: string[] = ['.']
  for (let i = 1; i <= segments.length; i++) {
    chain.push(segments.slice(0, i).join('/'))
  }

  let mask = 0
  for (const key of chain) {
    const node = byPath.get(key)
    if (!node) continue
    if (!node.inherit) mask = node.mask & PERMISSION_ALL
  }

  // 父级已显式授予权限时，祖先链上的节点若未配置，不额外降权
  return mask
}

/** 检查目标路径是否处于某个权限节点路径之下 */
export function isUnderPath(relativePath: string, ancestor: string): boolean {
  const p = normalizeNodePath(relativePath)
  const a = normalizeNodePath(ancestor)
  if (a === '.') return true
  return p === a || p.startsWith(a + '/')
}
