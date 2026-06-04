import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import type {
  AgentletServerOptions,
  AgentConnection,
  BridgeHelloParams,
  BridgeHelloResult,
  JsonRpcMessage,
  DaemonSpawnParams,
  DaemonStopParams,
} from '@agentlet/protocol'
import { BridgeMethods, BridgeErrorCodes } from '@agentlet/protocol'
import { AgentConnectionImpl } from './connection.js'

export interface DaemonEntry {
  daemonId: string
  token: string
  metadata: Record<string, unknown>
  machine?: { hostname: string; platform: string }
  bridge: { name: string; version: string }
  capabilities: { autoRestart: boolean; bufferLimit: number; maxAgents?: number }
  status: 'connected' | 'disconnected'
  connectedAt: Date
  ws: WebSocket
}

export class AgentletServer {
  private readonly options: Required<Pick<AgentletServerOptions, 'authenticate'>> & AgentletServerOptions
  private readonly connections = new Map<string, AgentConnectionImpl>()
  private readonly daemons = new Map<string, DaemonEntry>()
  private readonly wss: WebSocketServer
  private readonly handshakeTimeout: number
  private readonly outboundBufferLimit: number
  private daemonMessageRequestId = 1000

  get connectionCount(): number {
    return this.connections.size
  }

  get daemonCount(): number {
    return this.daemons.size
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

  /** Get a specific daemon by ID */
  getDaemon(id: string): DaemonEntry | undefined {
    return this.daemons.get(id)
  }

  /** List all connected daemons, optionally filtered by token */
  getDaemons(filter?: { token?: string }): DaemonEntry[] {
    const all = Array.from(this.daemons.values())
    return all.filter((d) => {
      if (filter?.token && d.token !== filter.token) return false
      return true
    })
  }

  /** Send a spawn command to a daemon */
  spawnOnDaemon(daemonId: string, params: DaemonSpawnParams): Promise<{ agentId: string; pid: number }> {
    const daemon = this.daemons.get(daemonId)
    if (!daemon || daemon.status !== 'connected') {
      return Promise.reject(new Error(`Daemon not found or disconnected: ${daemonId}`))
    }
    return this.sendDaemonRequest(daemon, BridgeMethods.SPAWN, params)
  }

  /** Send a stop command to a daemon */
  stopOnDaemon(daemonId: string, params: DaemonStopParams): Promise<{ stopped: boolean }> {
    const daemon = this.daemons.get(daemonId)
    if (!daemon || daemon.status !== 'connected') {
      return Promise.reject(new Error(`Daemon not found or disconnected: ${daemonId}`))
    }
    return this.sendDaemonRequest(daemon, BridgeMethods.STOP, params)
  }

  /** List agents on a daemon */
  listOnDaemon(daemonId: string): Promise<{ agents: Array<{ agentId: string; command: string; pid: number; cwd: string; status: string }> }> {
    const daemon = this.daemons.get(daemonId)
    if (!daemon || daemon.status !== 'connected') {
      return Promise.reject(new Error(`Daemon not found or disconnected: ${daemonId}`))
    }
    return this.sendDaemonRequest(daemon, BridgeMethods.LIST, {})
  }

  /** Gracefully close all connections and release resources */
  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.disconnect('server_shutting_down')
    }
    for (const daemon of this.daemons.values()) {
      const shutdownMsg: JsonRpcMessage = {
        jsonrpc: '2.0',
        method: BridgeMethods.SHUTDOWN,
        params: { reason: 'server_shutting_down' },
      }
      if (daemon.ws.readyState === WebSocket.OPEN) {
        daemon.ws.send(JSON.stringify(shutdownMsg))
        daemon.ws.close(1000, 'server_shutting_down')
      }
    }
    this.connections.clear()
    this.daemons.clear()
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

      // After handshake, route to agent connection or daemon (daemon responses are handled by pending promises)
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
        return
      }
      // Check if it's a daemon
      const daemon = this.findDaemonByWs(ws)
      if (daemon) {
        daemon.status = 'disconnected'
        console.log(`[agentlet-server] Daemon disconnected: ${daemon.daemonId}`)
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

      // Check if this is a daemon connection
      if (params.mode === 'daemon') {
        this.handleDaemonHello(ws, msg, params, authResult.metadata ?? {})
        return
      }

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
          agentInfo: params.agent
            ? { command: params.agent.command, pid: params.agent.pid, cwd: params.agent.cwd }
            : { command: 'unknown', pid: 0, cwd: '/' },
          session: params.session,
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

  private handleDaemonHello(
    ws: WebSocket,
    msg: { jsonrpc: '2.0'; method: string; id: number; params: Record<string, unknown> },
    params: BridgeHelloParams,
    metadata: Record<string, unknown>
  ): void {
    const daemonId = params.agentId
    const existingDaemon = this.daemons.get(daemonId)

    if (existingDaemon) {
      // Reconnection
      existingDaemon.ws = ws
      existingDaemon.status = 'connected'
      console.log(`[agentlet-server] Daemon reconnected: ${daemonId}`)
    } else {
      const daemon: DaemonEntry = {
        daemonId,
        token: params.token,
        metadata,
        machine: params.machine,
        bridge: params.bridge,
        capabilities: params.capabilities,
        status: 'connected',
        connectedAt: new Date(),
        ws,
      }
      this.daemons.set(daemonId, daemon)
      console.log(`[agentlet-server] Daemon connected: ${daemonId}`)
    }

    const response = {
      jsonrpc: '2.0' as const,
      id: msg.id,
      result: { agentId: daemonId, status: 'connected' } satisfies BridgeHelloResult,
    }
    ws.send(JSON.stringify(response))
  }

  private pendingDaemonRequests = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()

  private sendDaemonRequest<T>(daemon: DaemonEntry, method: string, params: unknown): Promise<T> {
    const id = ++this.daemonMessageRequestId
    const requestKey = `${daemon.daemonId}:${id}`

    return new Promise<T>((resolve, reject) => {
      this.pendingDaemonRequests.set(requestKey, { resolve, reject })

      const msg: JsonRpcMessage = {
        jsonrpc: '2.0',
        method,
        id,
        params: params as Record<string, unknown>,
      }
      daemon.ws.send(JSON.stringify(msg))

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingDaemonRequests.has(requestKey)) {
          this.pendingDaemonRequests.delete(requestKey)
          reject(new Error(`Daemon request timed out: ${method}`))
        }
      }, 30_000)

      // Listen for response
      const handler = (data: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const text = data.toString()
          const response = JSON.parse(text) as JsonRpcMessage
          if ('id' in response && response.id === id) {
            daemon.ws.off('message', handler)
            this.pendingDaemonRequests.delete(requestKey)
            if ('error' in response && response.error) {
              reject(new Error(response.error.message))
            } else if ('result' in response) {
              resolve(response.result as T)
            }
          }
        } catch { /* not our message */ }
      }
      daemon.ws.on('message', handler)
    })
  }

  private findConnectionByWs(ws: WebSocket): AgentConnectionImpl | undefined {
    for (const conn of this.connections.values()) {
      if (conn.hasWs(ws)) return conn
    }
    return undefined
  }

  private findDaemonByWs(ws: WebSocket): DaemonEntry | undefined {
    for (const daemon of this.daemons.values()) {
      if (daemon.ws === ws) return daemon
    }
    return undefined
  }
}
