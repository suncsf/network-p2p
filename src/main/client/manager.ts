import { randomUUID } from 'node:crypto'
import { LatticeClient } from './client'
import type { LoginResult, ServerEvent, ConnectionState, ConnectionInfo } from '@shared/protocol'

export type { ConnectionInfo }

/**
 * 多连接管理器：每个连接拥有独立的 LatticeClient 实例，
 * 所有事件按连接 id 推送，渲染层据此渲染多选项卡。
 */
export class ConnectionManager {
  private clients = new Map<string, LatticeClient>()
  private infos = new Map<string, ConnectionInfo>()

  constructor(
    private onState: (info: ConnectionInfo) => void,
    private onEvent: (connId: string, ev: ServerEvent) => void
  ) {}

  list(): ConnectionInfo[] {
    return Array.from(this.infos.values())
  }

  get(id: string): ConnectionInfo | undefined {
    return this.infos.get(id)
  }

  /** 建立新连接，成功返回连接信息；失败抛出且不保留 */
  async connect(opts: {
    host: string
    port: number
    username: string
    password: string
    id?: string
  }): Promise<ConnectionInfo> {
    const id = opts.id ?? randomUUID()
    const client = new LatticeClient(
      (state: ConnectionState, error?: string) => {
        const info = this.infos.get(id)
        if (!info) return
        info.state = state
        info.error = error
        if (client.loginResult) info.login = client.loginResult
        this.onState({ ...info })
      },
      (ev: ServerEvent) => this.onEvent(id, ev)
    )
    try {
      const login = await client.connect({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        password: opts.password
      })
      const info: ConnectionInfo = {
        id,
        host: opts.host,
        port: opts.port,
        username: opts.username,
        state: 'connected',
        login
      }
      this.clients.set(id, client)
      this.infos.set(id, info)
      return { ...info }
    } catch (e) {
      // 清理失败的客户端，避免残留自动重连
      try {
        await client.disconnect()
      } catch {
        /* ignore */
      }
      throw e
    }
  }

  request<T = unknown>(id: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const c = this.clients.get(id)
    if (!c) return Promise.reject(new Error('连接不存在或已关闭'))
    return c.request<T>(method, params)
  }

  async disconnect(id: string): Promise<boolean> {
    const c = this.clients.get(id)
    if (!c) return false
    await c.disconnect()
    this.clients.delete(id)
    this.infos.delete(id)
    return true
  }

  async disconnectAll(): Promise<void> {
    for (const id of Array.from(this.clients.keys())) {
      await this.disconnect(id)
    }
  }
}
