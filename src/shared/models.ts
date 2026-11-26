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
