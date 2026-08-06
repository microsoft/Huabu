import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import {
  AgentletMethods,
  AgentMethods,
  PROTOCOL_VERSION,
  type AgentletHelloParams,
  type AgentletHelloResult,
  type AgentHelloParams,
  type AgentHelloResult,
  type AgentletProfile,
  type SessionProfile,
  type JsonRpcMessage,
} from '@agentlet/protocol'
import type { SessionProfile as BootstrapProfile } from './session-bootstrap.js'

export interface WsClientOptions {
  serverUrl: string
  token: string
  sessionId: string
  /** Connection role — agentlet control channel or per-session relay */
  role: 'agentlet' | 'session'
  /** Machine identity shared by the control and session channels */
  agentletId: string
  /** Agent process info (required for role=session) */
  agent?: {
    command: string
    pid: number
    cwd: string
  }
  /** ACP session capabilities (from bootstrap) */
  session?: BootstrapProfile
  capabilities: { autoRestart: boolean; bufferLimit: number; maxAgents?: number }
  heartbeatInterval?: number
  allowInsecure?: boolean
  machine?: { hostname: string; platform: string }
}

export interface WsClientEvents {
  open: []
  message: [data: JsonRpcMessage]
  close: [code: number, reason: string]
  error: [error: Error]
  handshake_ok: [result: AgentHelloResult]
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

    if (!options.allowInsecure && !options.serverUrl.startsWith('wss://')) {
      throw new Error(
        `Server URL must use wss:// (got ${options.serverUrl}). ` +
        'Use --allow-insecure for local development.'
      )
    }
  }

  connect(): void {
    if (this.ws) {
      throw new Error('WebSocket already connected')
    }

    this.handshakeReceived = false
    // Token, role, and id go in query params
    const url = new URL(this.options.serverUrl)
    url.searchParams.set('token', this.options.token)
    url.searchParams.set('role', this.options.role === 'agentlet' ? 'agentlet' : 'session')
    url.searchParams.set('id', this.options.role === 'agentlet'
      ? this.options.agentletId
      : this.options.sessionId)
    this.ws = new WebSocket(url.toString())

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

  send(message: JsonRpcMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false
    }
    this.ws.send(JSON.stringify(message))
    return true
  }

  close(code = 1000, reason = ''): void {
    this.stopHeartbeat()
    this.ws?.close(code, reason)
  }

  private sendHello(): void {
    if (this.options.role === 'agentlet') {
      this.sendAgentletHello()
    } else {
      this.sendAgentHello()
    }
  }

  private sendAgentletHello(): void {
    const agentletProfile: AgentletProfile = {
      bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
      capabilities: this.options.capabilities,
    }
    if (this.options.machine) {
      agentletProfile.machine = this.options.machine
    }

    const params: AgentletHelloParams = {
      agentletId: this.options.agentletId,
      agentletProfile,
    }

    this.send({
      jsonrpc: '2.0' as const,
      method: AgentletMethods.HELLO,
      id: 1,
      params: params as unknown as Record<string, unknown>,
    })
  }

  private sendAgentHello(): void {
    const sessionProfile: SessionProfile = {
      agentletId: this.options.agentletId,
      bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
      agent: this.options.agent!,
      capabilities: this.options.capabilities,
    }

    if (this.options.session) {
      sessionProfile.session = {
        supportsLoad: this.options.session.supportsLoad,
        supportsResume: this.options.session.supportsResume,
        initializeResult: this.options.session.initializeResult,
        newSessionResult: this.options.session.newSessionResult,
      }
    }

    if (this.options.machine) {
      sessionProfile.machine = this.options.machine
    }

    const params: AgentHelloParams = {
      sessionId: this.options.sessionId,
      sessionProfile,
    }

    const hello = {
      jsonrpc: '2.0' as const,
      method: AgentMethods.HELLO,
      id: 1,
      params: params as unknown as Record<string, unknown>,
    }

    this.send(hello)
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (!this.handshakeReceived && 'id' in msg && msg.id === 1) {
      this.handshakeReceived = true
      if ('error' in msg && msg.error) {
        this.emit('handshake_error', msg.error)
      } else if ('result' in msg) {
        this.emit('handshake_ok', msg.result as AgentHelloResult)
      }
      return
    }

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
