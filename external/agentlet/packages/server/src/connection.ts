import WebSocket from 'ws'
import type {
  AgentConnection,
  AcpMessage,
  LifecycleEvent,
  JsonRpcMessage,
} from '@agentlet/protocol'
import { AgentMethods, ServerMethods } from '@agentlet/protocol'

export type ConnectionRole = 'agentlet' | 'agent-session'

export interface AgentConnectionImplOptions {
  sessionId: string
  agentletId: string
  role: ConnectionRole
  metadata: Record<string, unknown>
  ws: WebSocket
  outboundBufferLimit: number
}

export class AgentConnectionImpl implements AgentConnection {
  readonly sessionId: string
  readonly agentletId: string
  readonly role: ConnectionRole
  readonly metadata: Record<string, unknown>
  readonly connectedAt: Date

  private ws: WebSocket | null
  private _status: 'connected' | 'disconnected' = 'connected'
  private outboundBuffer: AcpMessage[] = []
  private readonly outboundBufferLimit: number

  private messageHandlers: Array<(message: AcpMessage) => void> = []
  private lifecycleHandlers: Array<(event: LifecycleEvent) => void> = []
  private persistCallback?: (dir: 'agent' | 'host', message: AcpMessage) => void

  get status(): 'connected' | 'disconnected' {
    return this._status
  }

  constructor(options: AgentConnectionImplOptions) {
    this.sessionId = options.sessionId
    this.agentletId = options.agentletId
    this.role = options.role
    this.metadata = options.metadata
    this.ws = options.ws
    this.outboundBufferLimit = options.outboundBufferLimit
    this.connectedAt = new Date()
  }

  send(message: AcpMessage): void {
    this.persistCallback?.('host', message)
    if (this._status === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    } else {
      if (this.outboundBuffer.length >= this.outboundBufferLimit) {
        throw new Error(
          `Outbound buffer full (${this.outboundBufferLimit} messages). ` +
          `Cannot buffer more messages for ${this.sessionId}.`
        )
      }
      this.outboundBuffer.push(message)
    }
  }

  onMessage(handler: (message: AcpMessage) => void): void {
    this.messageHandlers.push(handler)
  }

  onLifecycle(handler: (event: LifecycleEvent) => void): void {
    this.lifecycleHandlers.push(handler)
  }

  /** @internal — set callback for event persistence */
  setPersistCallback(callback: (dir: 'agent' | 'host', message: AcpMessage) => void): void {
    this.persistCallback = callback
  }

  disconnect(reason?: string): void {
    const shutdownMsg = {
      jsonrpc: '2.0' as const,
      method: ServerMethods.SHUTDOWN,
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
    // Check if it's a protocol control message (exact match on known methods)
    if ('method' in msg && typeof msg.method === 'string') {
      if (this.isProtocolMethod(msg.method)) {
        this.handleProtocolMessage(msg)
        return
      }
    }

    // Persist before dispatching to handlers
    this.persistCallback?.('agent', msg as AcpMessage)

    // ACP message from the agent
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
  handleReconnect(ws: WebSocket): void {
    // Close old WS if still open
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'replaced_by_reconnection')
    }
    this.ws = ws
    this._status = 'connected'
  }

  /** @internal — flush buffered outbound messages after reconnection */
  flushOutboundBuffer(): void {
    if (this.outboundBuffer.length === 0) return

    const replayMsg = {
      jsonrpc: '2.0' as const,
      method: ServerMethods.REPLAY,
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

  /** @internal — send a JSON-RPC request to this connection's WS */
  sendRaw(msg: JsonRpcMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  private isProtocolMethod(method: string): boolean {
    return method === AgentMethods.EXITED
      || method === AgentMethods.RESTARTED
      || method === AgentMethods.GOODBYE
      || method === AgentMethods.OVERFLOW
      || method === AgentMethods.SUSPENDED
  }

  private handleProtocolMessage(msg: JsonRpcMessage): void {
    if (!('method' in msg)) return
    const method = msg.method
    const params = 'params' in msg ? (msg.params as Record<string, unknown>) : {}

    switch (method) {
      case AgentMethods.EXITED: {
        const event: LifecycleEvent = {
          type: 'agent/exited',
          code: (params['code'] as number | null) ?? null,
          signal: (params['signal'] as string | null) ?? null,
          willRestart: (params['willRestart'] as boolean) ?? false,
        }
        for (const handler of this.lifecycleHandlers) handler(event)
        break
      }
      case AgentMethods.RESTARTED: {
        const event: LifecycleEvent = {
          type: 'agent/restarted',
          pid: params['pid'] as number,
          attempt: params['attempt'] as number,
        }
        for (const handler of this.lifecycleHandlers) handler(event)
        break
      }
      case AgentMethods.OVERFLOW: {
        const event: LifecycleEvent = {
          type: 'agent/overflow',
          dropped: params['dropped'] as number,
        }
        for (const handler of this.lifecycleHandlers) handler(event)
        break
      }
      case AgentMethods.GOODBYE: {
        const event: LifecycleEvent = {
          type: 'agent/goodbye',
          reason: (params['reason'] as string) ?? 'unknown',
        }
        for (const handler of this.lifecycleHandlers) handler(event)
        break
      }
      case AgentMethods.SUSPENDED: {
        const event: LifecycleEvent = {
          type: 'agent/suspended',
          sessionId: params['sessionId'] as string,
          reason: (params['reason'] as string) ?? 'unknown',
        }
        for (const handler of this.lifecycleHandlers) handler(event)
        break
      }
    }
  }
}
