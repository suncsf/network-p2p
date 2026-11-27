import type { PermissionNode } from './permissions'

/** 服务端账户视图（供渲染层使用，不依赖主进程实现） */
export interface AccountView {
  id: number
  username: string
  enabled: boolean
  isAdmin: boolean
  lockedUntil: number
  createdAt: number
  grants: GrantView[]
}

export interface GrantView {
  id: number
  rootPath: string
  label: string
  defaultMask: number
  nodes: PermissionNode[]
}

export interface AuditRow {
  id: number
  ts: number
  actor: string | null
  action: string
  detail: string | null
}

/** 服务端当前在线连接视图（一个登录会话一条） */
export interface ServerSessionView {
  username: string
  address: string
  /** 登录时间（epoch ms） */
  loginAt: number
  /** 最近一次活跃时间（epoch ms） */
  lastSeen: number
}
