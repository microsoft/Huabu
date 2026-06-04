import WebSocket from 'ws'
import type {
  AgentConnection,
  AcpMessage,
  BridgeHelloParams,
  BridgeLifecycleEvent,
  JsonRpcMessage,
} from '@agentlet/protocol'
import { BridgeMethods } from '@agentlet/protocol'

export interface AgentConnectionImplOptions {
  agentId: string
  token: string
  metadata: Record<string, unknown>
  agentInfo: { command: string; pid: number; cwd: string }
  session?: { sessionId: string; supportsLoad: boolean; initializeResult: unknown }
  machine?: { hostname: string; platform: string }
  bridge: { name: string; version: string }
  capabilities: { autoRestart: boolean; bufferLimit: number }
  ws: WebSocket
  outboundBufferLimit: number
}

export class AgentConnectionImpl implements AgentConnection {
  readonly agentId: string
  readonly token: string
  readonly metadata: Record<string, unknown>
  readonly agentInfo: { command: string; pid: number; cwd: string }
  readonly session?: { sessionId: string; supportsLoad: boolean; initializeResult: unknown }
  readonly machine?: { hostname: string; platform: string }
  readonly bridge: { name: string; version: string }
  readonly capabilities: { autoRestart: boolean; bufferLimit: number }
  readonly connectedAt: Date

  private ws: WebSocket | null
  private _status: 'connected' | 'disconnected' = 'connected'
  private outboundBuffer: AcpMessage[] = []
  private readonly outboundBufferLimit: number

  private messageHandlers: Array<(message: AcpMessage) => void> = []
  private lifecycleHandlers: Array<(event: BridgeLifecycleEvent) => void> = []

  get status(): 'connected' | 'disconnected' {
    return this._status
  }

  constructor(options: AgentConnectionImplOptions) {
    this.agentId = options.agentId
    this.token = options.token
    this.metadata = options.metadata
    this.agentInfo = options.agentInfo
    this.session = options.session
    this.machine = options.machine
    this.bridge = options.bridge
    this.capabilities = options.capabilities
    this.ws = options.ws
    this.outboundBufferLimit = options.outboundBufferLimit
    this.connectedAt = new Date()
  }

  send(message: AcpMessage): void {
    if (this._status === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    } else {
      // Buffer for replay on reconnection
      if (this.outboundBuffer.length >= this.outboundBufferLimit) {
        throw new Error(
          `Outbound buffer full (${this.outboundBufferLimit} messages). ` +
          `Cannot buffer more messages for ${this.agentId}.`
        )
      }
      this.outboundBuffer.push(message)
    }
  }

  onMessage(handler: (message: AcpMessage) => void): void {
    this.messageHandlers.push(handler)
  }

  onLifecycle(handler: (event: BridgeLifecycleEvent) => void): void {
    this.lifecycleHandlers.push(handler)
  }

  disconnect(reason?: string): void {
    const shutdownMsg = {
      jsonrpc: '2.0' as const,
      method: BridgeMethods.SHUTDOWN,
      params: { reason: reason ?? 'server_requested' },
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(shutdownMsg))
      this.ws.close(1000, reason ?? 'server_requested')
    }
    this._status = 'disconnected'
    this.ws = null
  }

  /** @internal — called by server when a WS message arrives for this connection */
  handleIncomingMessage(msg: JsonRpcMessage): void {
    // Check if it's a bridge control message
    if ('method' in msg && typeof msg.method === 'string' && msg.method.startsWith('bridge/')) {
      this.handleBridgeMessage(msg)
      return
    }

    // Otherwise it's an ACP message from the agent
    for (const handler of this.messageHandlers) {
      handler(msg as AcpMessage)
    }
  }

  /** @internal — called by server when WebSocket closes */
  handleWsClose(): void {
    this._status = 'disconnected'
    this.ws = null
  }

  /** @internal — called by server on reconnection */
  handleReconnect(ws: WebSocket, params: BridgeHelloParams): void {
    this.ws = ws
    this._status = 'connected'
    // Update agent info (PID/cwd may have changed if agent was restarted)
    if (params.agent) {
      ;(this as { agentInfo: { command: string; pid: number; cwd: string } }).agentInfo = {
        command: params.agent.command,
        pid: params.agent.pid,
        cwd: params.agent.cwd,
      }
    }
    // Update session info
    if (params.session) {
      ;(this as { session?: { sessionId: string; supportsLoad: boolean; initializeResult: unknown } }).session = params.session
    }
  }

  /** @internal — flush buffered outbound messages after reconnection */
  flushOutboundBuffer(): void {
    if (this.outboundBuffer.length === 0) return

    const replayMsg = {
      jsonrpc: '2.0' as const,
      method: BridgeMethods.REPLAY,
      params: { messages: this.outboundBuffer },
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(replayMsg))
    }

    this.outboundBuffer = []
  }

  /** @internal — check if this connection owns the given WebSocket */
  hasWs(ws: WebSocket): boolean {
    return this.ws === ws
  }

  private handleBridgeMessage(msg: JsonRpcMessage): void {
    if (!('method' in msg)) return
    const method = msg.method
    const params = 'params' in msg ? (msg.params as Record<string, unknown>) : {}

    switch (method) {
      case BridgeMethods.AGENT_EXITED: {
        const event: BridgeLifecycleEvent = {
          type: 'agent_exited',
          code: (params['code'] as number | null) ?? null,
          signal: (params['signal'] as string | null) ?? null,
          willRestart: (params['willRestart'] as boolean) ?? false,
        }
        for (const handler of this.lifecycleHandlers) handler(event)
        break
      }
      case BridgeMethods.AGENT_RESTARTED: {
        const event: BridgeLifecycleEvent = {
          type: 'agent_restarted',
          pid: params['pid'] as number,
          attempt: params['attempt'] as number,
        }
        for (const handler of this.lifecycleHandlers) handler(event)
        break
      }
      case BridgeMethods.BUFFER_OVERFLOW: {
        const event: BridgeLifecycleEvent = {
          type: 'buffer_overflow',
          dropped: params['dropped'] as number,
        }
        for (const handler of this.lifecycleHandlers) handler(event)
        break
      }
      case BridgeMethods.GOODBYE: {
        const event: BridgeLifecycleEvent = {
          type: 'goodbye',
          reason: (params['reason'] as string) ?? 'unknown',
        }
        for (const handler of this.lifecycleHandlers) handler(event)
        break
      }
    }
  }
}
