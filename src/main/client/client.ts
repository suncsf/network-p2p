import WebSocket from 'ws'
import type { RpcRequest, RpcResponse, ErrorCode, ServerEvent, LoginResult } from '@shared/protocol'

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface ClientOptions {
  host: string
  port: number
  username: string
  password: string
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class LatticeClient {
  private ws?: WebSocket
  private nextId = 1
  private pending = new Map<number, Pending>()
  private state: ConnectionState = 'idle'
  private opts?: ClientOptions
  private reconnectTimer?: NodeJS.Timeout
  private reconnectDelay = 1000
  private manualClose = false
  /** 鉴权类失败（密码错/锁定/禁用）：重试无意义且会反复触发账户锁定，禁止自动重连 */
  private noRetry = false
  private heartbeatTimer?: NodeJS.Timeout

  token?: string
  loginResult?: LoginResult

  constructor(
    private onState: (state: ConnectionState, error?: string) => void,
    private onEvent: (ev: ServerEvent) => void
  ) {}

  getState(): ConnectionState {
    return this.state
  }

  private setState(s: ConnectionState, err?: string): void {
    this.state = s
    this.onState(s, err)
  }

  connect(opts: ClientOptions): Promise<LoginResult> {
    this.opts = opts
    this.manualClose = false
    this.noRetry = false
    return this.doConnect(true)
  }

  private doConnect(first: boolean): Promise<LoginResult> {
    const opts = this.opts!
    this.setState(first ? 'connecting' : 'reconnecting')
    return new Promise<LoginResult>((resolve, reject) => {
      const ws = new WebSocket(`ws://${opts.host}:${opts.port}`)
      this.ws = ws

      const fail = (err: Error): void => {
        if (first || this.noRetry) reject(err)
        else this.scheduleReconnect()
      }

      ws.once('error', fail)
      ws.once('open', async () => {
        ws.off('error', fail)
        try {
          const result = await this.request<LoginResult>('login', {
            username: opts.username,
            password: opts.password
          })
          this.token = result.token
          this.loginResult = result
          this.setState('connected')
          this.reconnectDelay = 1000
          this.startHeartbeat()
          resolve(result)
        } catch (e) {
          ws.close()
          const err = e as Error & { code?: string }
          // 鉴权类失败：停止重连，保留错误状态供 UI 展示与手动处理
          if (['UNAUTHORIZED', 'LOCKED', 'FORBIDDEN'].includes(err.code ?? '')) {
            this.noRetry = true
            this.manualClose = true
            this.setState('error', err.message)
          }
          reject(err)
        }
      })

      ws.on('message', (raw) => this.onMessage(raw.toString('utf8')))
      ws.on('close', () => {
        this.stopHeartbeat()
        for (const p of this.pending.values()) p.reject(new Error('连接已断开'))
        this.pending.clear()
        if (this.manualClose) {
          this.setState(this.noRetry ? 'error' : 'idle')
          return
        }
        this.setState('reconnecting')
        this.scheduleReconnect()
      })
    })
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.noRetry || !this.opts) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.doConnect(false).catch(() => this.scheduleReconnect())
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.state === 'connected') {
        this.request('ping', {}).catch(() => {})
      }
    }, 20000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
  }

  private onMessage(raw: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof msg === 'object' && msg !== null && 'event' in msg) {
      this.onEvent(msg as ServerEvent)
      return
    }
    const resp = msg as RpcResponse
    const p = this.pending.get(resp.id)
    if (!p) return
    this.pending.delete(resp.id)
    if (resp.ok) p.resolve(resp.result)
    else {
      const err = new Error(resp.error?.message ?? '请求失败') as Error & { code?: ErrorCode }
      err.code = resp.error?.code
      p.reject(err)
    }
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30000
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('未连接'))
    }
    const id = this.nextId++
    const payload: RpcRequest = { id, method, params: { ...params, token: this.token } }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws!.send(JSON.stringify(payload))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('请求超时'))
        }
      }, timeoutMs)
    })
  }

  disconnect(): Promise<void> {
    this.manualClose = true
    clearTimeout(this.reconnectTimer)
    this.stopHeartbeat()
    return new Promise((resolve) => {
      if (!this.ws) {
        this.setState('idle')
        return resolve()
      }
      this.ws.once('close', () => resolve())
      this.ws.close()
      this.token = undefined
      this.loginResult = undefined
    })
  }
}
