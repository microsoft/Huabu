import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import type {
  AgentletServerOptions,
  AgentConnection,
  BridgeHelloParams,
  BridgeHelloResult,
  JsonRpcMessage,
} from '@agentlet/protocol'
import { BridgeMethods, BridgeErrorCodes } from '@agentlet/protocol'
import { AgentConnectionImpl } from './connection.js'

export class AgentletServer {
  private readonly options: Required<Pick<AgentletServerOptions, 'authenticate'>> & AgentletServerOptions
  private readonly connections = new Map<string, AgentConnectionImpl>()
  private readonly wss: WebSocketServer
  private readonly handshakeTimeout: number
  private readonly outboundBufferLimit: number

  get connectionCount(): number {
    return this.connections.size
  }

  constructor(options: AgentletServerOptions) {
    this.options = options
    this.handshakeTimeout = options.handshakeTimeout ?? 10_000
    this.outboundBufferLimit = options.outboundBufferLimit ?? 100
    this.wss = new WebSocketServer({ noServer: true })
  }

  /** Handle HTTP upgrade request — framework-agnostic */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onWebSocket(ws)
    })
  }

  /** Get a specific agent connection by ID */
  getConnection(id: string): AgentConnection | undefined {
    return this.connections.get(id)
  }

  /** List all connections, optionally filtered by status or token */
  getConnections(filter?: { status?: 'connected' | 'disconnected'; token?: string }): AgentConnection[] {
    const all = Array.from(this.connections.values())
    return all.filter((c) => {
      if (filter?.status && c.status !== filter.status) return false
      if (filter?.token && c.token !== filter.token) return false
      return true
    })
  }

  /** Gracefully close all connections and release resources */
  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.disconnect('server_shutting_down')
    }
    this.connections.clear()
    this.wss.close()
  }

  private onWebSocket(ws: WebSocket): void {
    let handshakeComplete = false

    // Enforce handshake timeout
    const timer = setTimeout(() => {
      if (!handshakeComplete) {
        const error = {
          jsonrpc: '2.0' as const,
          id: 1,
          error: { code: BridgeErrorCodes.HANDSHAKE_TIMEOUT, message: 'Handshake timeout' },
        }
        ws.send(JSON.stringify(error))
        ws.close(4003, 'Handshake timeout')
      }
    }, this.handshakeTimeout)

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        ws.close(4002, 'Binary frames not supported')
        return
      }

      const text = data.toString()
      let msg: JsonRpcMessage

      try {
        msg = JSON.parse(text) as JsonRpcMessage
      } catch {
        ws.close(4001, 'Invalid JSON')
        return
      }

      // Before handshake, only accept bridge/hello
      if (!handshakeComplete) {
        if (!('method' in msg) || msg.method !== BridgeMethods.HELLO) {
          ws.close(4004, 'Expected bridge/hello')
          return
        }
        clearTimeout(timer)
        handshakeComplete = true
        await this.handleHello(ws, msg as { jsonrpc: '2.0'; method: string; id: number; params: Record<string, unknown> })
        return
      }

      // After handshake, find the connection and route the message
      const conn = this.findConnectionByWs(ws)
      if (conn) {
        conn.handleIncomingMessage(msg)
      }
    })

    ws.on('close', () => {
      clearTimeout(timer)
      const conn = this.findConnectionByWs(ws)
      if (conn) {
        conn.handleWsClose()
        this.options.onDisconnection?.(conn, 'websocket_closed')
      }
    })

    ws.on('error', () => {
      clearTimeout(timer)
    })
  }

  private async handleHello(
    ws: WebSocket,
    msg: { jsonrpc: '2.0'; method: string; id: number; params: Record<string, unknown> }
  ): Promise<void> {
    const params = msg.params as unknown as BridgeHelloParams

    try {
      const authResult = await this.options.authenticate(params.token, params)

      const agentId = params.agentId
      const existingConn = this.connections.get(agentId)

      if (existingConn) {
        // Reconnection — same agentId, swap WebSocket
        existingConn.handleReconnect(ws, params)

        const response = {
          jsonrpc: '2.0' as const,
          id: msg.id,
          result: { agentId, status: 'connected' } satisfies BridgeHelloResult,
        }
        ws.send(JSON.stringify(response))

        // Replay buffered messages
        existingConn.flushOutboundBuffer()
        this.options.onReconnection?.(existingConn)
      } else {
        // New connection
        const conn = new AgentConnectionImpl({
          agentId,
          token: params.token,
          metadata: authResult.metadata ?? {},
          agentInfo: params.agent,
          machine: params.machine,
          bridge: params.bridge,
          capabilities: params.capabilities,
          ws,
          outboundBufferLimit: this.outboundBufferLimit,
        })

        this.connections.set(agentId, conn)

        const response = {
          jsonrpc: '2.0' as const,
          id: msg.id,
          result: { agentId, status: 'connected' } satisfies BridgeHelloResult,
        }
        ws.send(JSON.stringify(response))

        this.options.onConnection?.(conn)
      }
    } catch (err) {
      const response = {
        jsonrpc: '2.0' as const,
        id: msg.id,
        error: {
          code: BridgeErrorCodes.INVALID_TOKEN,
          message: err instanceof Error ? err.message : 'Authentication failed',
        },
      }
      ws.send(JSON.stringify(response))
      ws.close(4001, 'Authentication failed')
    }
  }

  private findConnectionByWs(ws: WebSocket): AgentConnectionImpl | undefined {
    for (const conn of this.connections.values()) {
      if (conn.hasWs(ws)) return conn
    }
    return undefined
  }
}
