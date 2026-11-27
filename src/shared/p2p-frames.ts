/** P2P 帧类型 */
export enum P2PFrameType {
  HELLO = 0x01,
  MANIFEST = 0x02,
  CHUNK = 0x03,
  ACK = 0x04,
  DONE = 0x05,
  ERROR = 0x06,
  DECISION = 0x07
}

export const P2P_MAGIC = 0x4c4154 // "LAT"
/** v2：CHUNK/ACK 帧偏移量由 UInt32 改为 BigUInt64，支持 >4GB 文件 */
export const P2P_VERSION = 2
/** 单帧载荷最大值 1MB */
export const MAX_FRAME_SIZE = 1024 * 1024
/** 默认分块大小 64KB */
export const DEFAULT_CHUNK_SIZE = 64 * 1024

export interface P2PFrameHeader {
  magic: number
  version: number
  type: P2PFrameType
  /** 载荷长度 */
  length: number
}

export interface P2PHello {
  token: string
  sessionId: string
}

export interface P2PManifestFile {
  id: number
  path: string
  size: number
  sha256: string
}

export interface P2PManifest {
  totalSize: number
  files: P2PManifestFile[]
}

export interface P2PChunk {
  fileId: number
  offset: number
  data: Uint8Array
}

export interface P2PAck {
  fileId: number
  offset: number
  length: number
}

export interface P2PDecision {
  accepted: boolean
  reason?: string
}

export interface P2PError {
  code: string
  message: string
}

/** 编码帧头（12 字节） */
export function encodeHeader(header: P2PFrameHeader): Buffer {
  const buf = Buffer.alloc(12)
  buf.writeUInt32BE(header.magic >>> 0, 0)
  buf.writeUInt8(header.version, 4)
  buf.writeUInt8(header.type, 5)
  buf.writeUInt16BE(0, 6)
  buf.writeUInt32BE(header.length >>> 0, 8)
  return buf
}

export function decodeHeader(buf: Buffer): P2PFrameHeader {
  return {
    magic: buf.readUInt32BE(0),
    version: buf.readUInt8(4),
    type: buf.readUInt8(5) as P2PFrameType,
    length: buf.readUInt32BE(8)
  }
}
