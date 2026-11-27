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
  /** 下载方向（receive，对方把文件传到本机）的文件概要，供本机确认卡片展示；可省略 */
  fileName?: string
  fileCount?: number
  totalSize?: number
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

/** P2P 传输进度事件（上传端/下载端都会广播） */
export interface TransferProgressEvent {
  sessionId: string
  sent?: number
  total?: number
  done?: boolean
  /** 下载方拒绝 / 确认超时 */
  cancelled?: boolean
  /** 传输中途失败（可续传） */
  failed?: boolean
  reason?: string
}

/* ------------------------------ IP 段检测 ------------------------------ */

/** 本机网卡信息（工作区「IP 段检测」弹窗展示用） */
export interface LocalNic {
  /** 网卡名（如 以太网 / WLAN） */
  name: string
  /** 本机 IPv4 地址 */
  address: string
  /** 子网掩码（点分十进制） */
  netmask: string
  /** 由地址 + 掩码推导的网段 CIDR（如 192.168.1.0/24） */
  cidr: string
}

/** 单个 IP 的探测结果 */
export interface ProbeResult {
  host: string
  port: number
  /** 服务端返回了确认数据 → 可连接 */
  alive: boolean
  /** 确认数据（可连接时有值） */
  service?: { name: string; hostname: string; protocolVersion: number }
  /** 不可连接原因（不可连接时有值） */
  error?: string
}

/** IP 段探测参数：cidr 网段 + 服务端默认端口 */
export interface ProbeRangeParams {
  cidr: string
  port: number
}

/* ------------------------------ 传输面板 ------------------------------ */

/** 传输记录状态：进行中 / 已暂停（保留断点可继续）/ 已完成 / 已取消 / 已中断（可断点续传） */
export type TransferState = 'active' | 'paused' | 'completed' | 'cancelled' | 'interrupted'

/** 传输记录类型：上传（upload） / P2P 上传（p2p-send，本机 → 对端） / P2P 下载（p2p-recv，对端 → 本机） / 下载（ws-recv，对方推送到本机共享目录） */
export type TransferKind = 'upload' | 'p2p-send' | 'p2p-recv' | 'ws-recv'

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
  /** 本机路径（上传为源文件；下载为目标位置） */
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
