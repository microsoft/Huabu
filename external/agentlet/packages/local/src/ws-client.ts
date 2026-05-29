import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import {
  BridgeMethods,
  PROTOCOL_VERSION,
  type BridgeHelloParams,
  type BridgeHelloResult,
  type JsonRpcMessage,
} from '@agentlet/protocol'

export interface WsClientOptions {
  serverUrl: string
  token: string
  agentCommand: string
  agentPid: number
  agentId: string
  capabilities: { autoRestart: boolean; bufferLimit: number }
  heartbeatInterval?: number
  allowInsecure?: boolean
  machine?: { hostname: string; platform: string }
}

export interface WsClientEvents {
  open: []
  message: [data: JsonRpcMessage]
  close: [code: number, reason: string]
  error: [error: Error]
  handshake_ok: [result: BridgeHelloResult]
  handshake_error: [error: { code: number; message: string }]
}

export class WsClient extends EventEmitter<WsClientEvents> {
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private readonly options: WsClientOptions
  private handshakeReceived = false

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  constructor(options: WsClientOptions) {
    super()
    this.options = options

    // Enforce TLS in production
    if (!options.allowInsecure && !options.serverUrl.startsWith('wss://')) {
      throw new Error(
        `Server URL must use wss:// (got ${options.serverUrl}). ` +
        'Use --allow-insecure for local development.'
      )
    }
  }

  /** Open WebSocket connection to the server */
  connect(): void {
    if (this.ws) {
      throw new Error('WebSocket already connected')
    }

    this.handshakeReceived = false
    this.ws = new WebSocket(this.options.serverUrl)

    this.ws.on('open', () => {
      this.emit('open')
      this.sendHello()
      this.startHeartbeat()
    })

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.emit('error', new Error('Received binary WebSocket frame (protocol violation)'))
        return
      }

      const text = data.toString()
      try {
        const msg = JSON.parse(text) as JsonRpcMessage
        this.handleMessage(msg)
      } catch {
        this.emit('error', new Error(`Invalid JSON from server: ${text.slice(0, 200)}`))
      }
    })

    this.ws.on('close', (code, reason) => {
      this.stopHeartbeat()
      this.ws = null
      this.emit('close', code, reason.toString())
    })

    this.ws.on('error', (err) => {
      this.emit('error', err)
    })
  }

  /** Send a JSON-RPC message over the WebSocket */
  send(message: JsonRpcMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false
    }
    this.ws.send(JSON.stringify(message))
    return true
  }

  /** Close the WebSocket connection gracefully */
  close(code = 1000, reason = ''): void {
    this.stopHeartbeat()
    this.ws?.close(code, reason)
  }

  private sendHello(): void {
    const params: BridgeHelloParams = {
      token: this.options.token,
      agentId: this.options.agentId,
      bridge: {
        name: 'agentlet',
        version: PROTOCOL_VERSION,
      },
      agent: {
        command: this.options.agentCommand,
        pid: this.options.agentPid,
      },
      capabilities: this.options.capabilities,
    }

    if (this.options.machine) {
      params.machine = this.options.machine
    }

    const hello = {
      jsonrpc: '2.0' as const,
      method: BridgeMethods.HELLO,
      id: 1,
      params: params as unknown as Record<string, unknown>,
    }

    this.send(hello)
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Check if this is the hello response (id === 1, only intercept once)
    if (!this.handshakeReceived && 'id' in msg && msg.id === 1) {
      this.handshakeReceived = true
      if ('error' in msg && msg.error) {
        this.emit('handshake_error', msg.error)
      } else if ('result' in msg) {
        this.emit('handshake_ok', msg.result as BridgeHelloResult)
      }
      return
    }

    // All other messages are relayed to the consumer
    this.emit('message', msg)
  }

  private startHeartbeat(): void {
    const interval = this.options.heartbeatInterval ?? 30
    if (interval <= 0) return

    this.pingTimer = setInterval(() => {
      this.ws?.ping()
    }, interval * 1000)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }
}
