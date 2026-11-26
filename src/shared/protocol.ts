import type { PermissionNode } from './permissions'

/** WS 协议版本 */
export const PROTOCOL_VERSION = 1

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'LOCKED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PORT_IN_USE'
  | 'PATH_VIOLATION'
  | 'TRANSFER_DENIED'
  | 'TRANSFER_TIMEOUT'
  | 'INTERNAL'

export interface RpcRequest<P = unknown> {
  id: number
  method: string
  params: P
}

export interface RpcResponse<R = unknown> {
  id: number
  ok: boolean
  result?: R
  error?: { code: ErrorCode; message: string }
}

export interface ServerEvent<P = unknown> {
  event: string
  data: P
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/** 单个连接会话的信息（供渲染层渲染多选项卡） */
export interface ConnectionInfo {
  id: string
  host: string
  port: number
  username: string
  state: ConnectionState
  error?: string
  /** 登录后服务端下发的授权信息 */
  login?: {
    token: string
    username: string
    protocolVersion: number
    grants: FileRootGrant[]
  }
}

/* ------------------------------ 鉴权 ------------------------------ */

export interface LoginRequest {
  username: string
  password: string
  clientName?: string
}

export interface FileRootGrant {
  /** 白名单根目录绝对路径（服务端展示用） */
  root: string
  /** 根目录在客户端可见名称 */
  label: string
  /** 该根目录的权限节点树 */
  nodes: PermissionNode[]
}

export interface LoginResult {
  token: string
  username: string
  protocolVersion: number
  grants: FileRootGrant[]
}

/* ------------------------------ 文件操作 ------------------------------ */

export interface FileEntry {
  name: string
  /** 相对白名单根目录的路径 */
  path: string
  type: 'file' | 'dir'
  size: number
  mtime: number
  isSymlink: boolean
}

export interface ListParams {
  root: string
  path: string
}

export interface ListResult {
  entries: FileEntry[]
}

export interface StatParams {
  root: string
  path: string
}

export interface StatResult {
  entry: FileEntry
}

export interface RenameParams {
  root: string
  path: string
  newName: string
}

export interface DeleteParams {
  root: string
  path: string
  recursive?: boolean
}

export interface MkdirParams {
  root: string
  path: string
}

export interface ReadFileParams {
  root: string
  path: string
}

export interface ReadFileResult {
  /** base64 编码内容（限制大小） */
  data: string
  size: number
}

export interface WriteFileParams {
  root: string
  path: string
  /** base64 编码内容 */
  data: string
}

/** 上传：分块写入 */
export interface UploadInitParams {
  root: string
  path: string
  size: number
}

export interface UploadChunkParams {
  uploadId: string
  offset: number
  /** base64 编码分块 */
  data: string
}

/* ------------------------------ 传输授权 ------------------------------ */

export interface TransferGrantParams {
  root: string
  path: string
  direction: 'send' | 'receive'
}

export interface TransferGrantResult {
  /** 一次性 P2P token */
  p2pToken: string
  /** 对端地址（局域网） */
  host: string
  port: number
  /** 传输会话 ID */
  sessionId: string
}

export interface TransferRequestEvent {
  sessionId: string
  from: string
  fileName: string
  fileCount: number
  totalSize: number
  expiresAt: number
}

export interface TransferDecisionParams {
  sessionId: string
  accept: boolean
}

/** P2P 传输进度事件（发送端/接收端都会广播） */
export interface TransferProgressEvent {
  sessionId: string
  sent?: number
  total?: number
  done?: boolean
  /** 接收方拒绝 / 确认超时 */
  cancelled?: boolean
  /** 传输中途失败（可续传） */
  failed?: boolean
  reason?: string
}

/* ------------------------------ 传输面板 ------------------------------ */

/** 传输记录状态：进行中 / 已完成 / 已取消 / 已中断（可断点续传） */
export type TransferState = 'active' | 'completed' | 'cancelled' | 'interrupted'

/** 传输记录类型：分块上传 / P2P 发送端 / P2P 接收端 */
export type TransferKind = 'upload' | 'p2p-send' | 'p2p-recv'

/** 统一传输面板的一条记录（持久化在 local.db） */
export interface TransferRecord {
  id: number
  kind: TransferKind
  /** 对端（远端用户名或地址） */
  peer: string
  /** 显示名（文件/目录名） */
  name: string
  /** 源端路径（相对授权根目录） */
  remotePath: string
  /** 本机路径（上传为源文件；接收为目标位置） */
  localPath: string
  total: number
  transferred: number
  state: TransferState
  error?: string | null
  createdAt: number
  updatedAt: number
  /** 传输会话 ID（同机收发的两条记录由此关联） */
  sessionId: string
}
