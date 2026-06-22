import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import type {
  AgentletServerOptions,
  AgentConnection,
  AgentHelloParams,
  AgentHelloResult,
  AgentletHelloParams,
  AgentletHelloResult,
  AgentSuspendedParams,
  SessionProfile,
  SpawnParams,
  StopParams,
  JsonRpcMessage,
} from '@agentlet/protocol'
import { AgentletMethods, AgentMethods, ServerMethods, ErrorCodes } from '@agentlet/protocol'
import { AgentConnectionImpl } from './connection.js'
import { DataStore, tokenSignature } from './data-store.js'
import { EventStore } from './event-store.js'
import { JsonlStorage } from './jsonl-storage.js'

export class AgentletServer {
  private readonly options: Required<Pick<AgentletServerOptions, 'authenticate'>> & AgentletServerOptions
  private readonly connections = new Map<string, AgentConnectionImpl>()
  private readonly wss: WebSocketServer
  private readonly handshakeTimeout: number
  private readonly outboundBufferLimit: number
  private agentletRequestId = 1000

  private dataStore!: DataStore
  private eventStore!: EventStore
  private initialized = false

  // Pending JSON-RPC request/response tracking for agentlet control
  private pendingRequests = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()

  get connectionCount(): number {
    return this.connections.size
  }

  constructor(options: AgentletServerOptions) {
    this.options = options
    this.handshakeTimeout = options.handshakeTimeout ?? 10_000
    this.outboundBufferLimit = options.outboundBufferLimit ?? 100
    this.wss = new WebSocketServer({ noServer: true })
  }

  /**
   * Initialize persistent stores. Must be called before accepting connections.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    const storeDir = this.options.storeDir
    this.dataStore = new DataStore({ filePath: join(storeDir, 'sessions.db') })
    await this.dataStore.init()
    this.eventStore = new EventStore(new JsonlStorage(join(storeDir, 'events')))
    console.log(`[agentlet-server] Stores initialized (dir: ${storeDir})`)

    this.initialized = true
  }

  getDataStore(): DataStore {
    return this.dataStore
  }

  /** @deprecated Use getDataStore() */
  getSessionStore(): DataStore {
    return this.dataStore
  }

  getEventStore(): EventStore {
    return this.eventStore
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onWebSocket(ws, req)
    })
  }

  /** Get a specific connection by sessionId */
  getConnection(sessionId: string): AgentConnection | undefined {
    return this.connections.get(sessionId)
  }

  /** List all connections, optionally filtered */
  getConnections(filter?: { status?: 'connected' | 'disconnected'; role?: 'agentlet' | 'agent-session' }): AgentConnectionImpl[] {
    const all = Array.from(this.connections.values())
    return all.filter((c) => {
      if (filter?.status && c.status !== filter.status) return false
      if (filter?.role && c.role !== filter.role) return false
      return true
    })
  }

  /** List parent agentlet connections */
  getAgentlets(): AgentConnectionImpl[] {
    return this.getConnections({ role: 'agentlet' })
  }

  /** List agent session connections */
  getAgentSessions(): AgentConnectionImpl[] {
    return this.getConnections({ role: 'agent-session' })
  }

  /** Send a spawn command to a parent agentlet */
  spawnOnAgentlet(agentletSessionId: string, params: SpawnParams): Promise<{ sessionId: string; pid: number }> {
    const conn = this.connections.get(agentletSessionId)
    if (!conn || conn.role !== 'agentlet' || conn.status !== 'connected') {
      return Promise.reject(new Error(`Agentlet not found or disconnected: ${agentletSessionId}`))
    }
    return this.sendAgentletRequest(conn, ServerMethods.SPAWN, params)
  }

  /** Send a stop command to a parent agentlet */
  stopOnAgentlet(agentletSessionId: string, params: StopParams): Promise<{ stopped: boolean }> {
    const conn = this.connections.get(agentletSessionId)
    if (!conn || conn.role !== 'agentlet' || conn.status !== 'connected') {
      return Promise.reject(new Error(`Agentlet not found or disconnected: ${agentletSessionId}`))
    }
    return this.sendAgentletRequest(conn, ServerMethods.STOP, params)
  }

  /** List agents on an agentlet */
  listOnAgentlet(agentletSessionId: string): Promise<{ agents: Array<{ sessionId: string; appId?: string; command: string; pid: number; cwd: string; status: string }> }> {
    const conn = this.connections.get(agentletSessionId)
    if (!conn || conn.role !== 'agentlet' || conn.status !== 'connected') {
      return Promise.reject(new Error(`Agentlet not found or disconnected: ${agentletSessionId}`))
    }
    return this.sendAgentletRequest(conn, ServerMethods.LIST, {})
  }

  /**
   * Push a resource file to a connected agentlet daemon.
   * The daemon resolves ${ENV_VAR} in `destination` and writes the file.
   */
  sendResource(agentletSessionId: string, params: { destination: string; content: string }): void {
    const conn = this.connections.get(agentletSessionId)
    if (!conn || conn.role !== 'agentlet' || conn.status !== 'connected') {
      return
    }
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: ServerMethods.SEND_RESOURCE,
      params: params as unknown as Record<string, unknown>,
    }
    conn.sendRaw(msg)
  }

  /** Gracefully close all connections and release resources */
  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.disconnect('server_shutting_down')
    }
    this.connections.clear()
    this.wss.close()
    this.eventStore?.close()
    this.dataStore?.close()
  }

  private onWebSocket(ws: WebSocket, req: IncomingMessage): void {
    let handshakeComplete = false

    // Extract token and role from query params
    const url = new URL(req.url ?? '', 'http://localhost')
    const token = url.searchParams.get('token') ?? ''
    const queryRole = url.searchParams.get('role') as 'agentlet' | 'session' | null
    const queryId = url.searchParams.get('id') ?? ''

    const timer = setTimeout(() => {
      if (!handshakeComplete) {
        const error = {
          jsonrpc: '2.0' as const,
          id: 1,
          error: { code: ErrorCodes.HANDSHAKE_TIMEOUT, message: 'Handshake timeout' },
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

      if (!handshakeComplete) {
        if (!('method' in msg) || !('id' in msg)) {
          ws.close(4004, 'Expected hello request')
          return
        }

        const method = msg.method as string
        const helloMsg = msg as { jsonrpc: '2.0'; method: string; id: number; params: Record<string, unknown> }

        if (method === AgentletMethods.HELLO) {
          if (queryRole && queryRole !== 'agentlet') {
            ws.close(4004, `Role mismatch: expected ${queryRole} hello, got agentlet/hello`)
            return
          }
          clearTimeout(timer)
          handshakeComplete = true
          await this.handleAgentletHello(ws, token, queryId, helloMsg)
        } else if (method === AgentMethods.HELLO) {
          if (queryRole && queryRole !== 'session') {
            ws.close(4004, `Role mismatch: expected ${queryRole} hello, got agent/hello`)
            return
          }
          clearTimeout(timer)
          handshakeComplete = true
          await this.handleAgentHello(ws, token, helloMsg)
        } else {
          ws.close(4004, 'Expected agentlet/hello or agent/hello')
        }
        return
      }

      // After handshake, route to the connection
      const conn = this.findConnectionByWs(ws)
      if (conn) {
        // Check if it's a JSON-RPC response to a pending agentlet control request
        if ('id' in msg && !('method' in msg) && this.hasPendingRequest(conn.sessionId, msg.id as string | number)) {
          this.handlePendingResponse(conn, msg)
        } else {
          conn.handleIncomingMessage(msg)
        }
      }
    })

    ws.on('close', () => {
      clearTimeout(timer)
      const conn = this.findConnectionByWs(ws)
      if (conn) {
        conn.handleWsClose()
        // Update session status for agent-sessions
        if (conn.role === 'agent-session' && this.dataStore) {
          const existing = this.dataStore.getSession(conn.sessionId)
          if (existing && existing.status !== 'suspended') {
            this.dataStore.updateSessionStatus(conn.sessionId, 'closed')
          }
        }
        this.options.onDisconnection?.(conn, 'websocket_closed')
      }
    })

    ws.on('error', () => {
      clearTimeout(timer)
    })
  }

  private async handleAgentletHello(
    ws: WebSocket,
    token: string,
    queryId: string,
    msg: { jsonrpc: '2.0'; method: string; id: number; params: Record<string, unknown> }
  ): Promise<void> {
    const params = msg.params as unknown as AgentletHelloParams

    // Validate required fields
    if (!params.agentletId || !params.agentletProfile) {
      const response = {
        jsonrpc: '2.0' as const,
        id: msg.id,
        error: { code: ErrorCodes.INVALID_REQUEST, message: 'Missing agentletId or agentletProfile' },
      }
      ws.send(JSON.stringify(response))
      ws.close(4001, 'Invalid agentlet/hello params')
      return
    }

    // Validate query id matches body if provided
    if (queryId && queryId !== params.agentletId) {
      const response = {
        jsonrpc: '2.0' as const,
        id: msg.id,
        error: { code: ErrorCodes.INVALID_REQUEST, message: `Query param id "${queryId}" does not match agentletId "${params.agentletId}"` },
      }
      ws.send(JSON.stringify(response))
      ws.close(4001, 'ID mismatch')
      return
    }

    try {
      const authResult = await this.options.authenticate(token, params)

      const agentletId = params.agentletId
      const existingConn = this.connections.get(agentletId)

      if (existingConn) {
        if (existingConn.role !== 'agentlet') {
          const response = {
            jsonrpc: '2.0' as const,
            id: msg.id,
            error: { code: ErrorCodes.DUPLICATE_SESSION, message: `ID "${agentletId}" exists as agent-session` },
          }
          ws.send(JSON.stringify(response))
          ws.close(4002, 'Role mismatch')
          return
        }

        existingConn.handleReconnect(ws)
        this.persistAgentletRecord(params, token)
        const response = {
          jsonrpc: '2.0' as const,
          id: msg.id,
          result: { agentletId, status: 'registered' } satisfies AgentletHelloResult,
        }
        ws.send(JSON.stringify(response))
        existingConn.flushOutboundBuffer()
      } else {
        const conn = new AgentConnectionImpl({
          sessionId: agentletId,
          agentletId: agentletId,
          role: 'agentlet',
          metadata: authResult.metadata ?? {},
          ws,
          outboundBufferLimit: this.outboundBufferLimit,
        })

        this.connections.set(agentletId, conn)
        this.persistAgentletRecord(params, token)
        const response = {
          jsonrpc: '2.0' as const,
          id: msg.id,
          result: { agentletId, status: 'registered' } satisfies AgentletHelloResult,
        }
        ws.send(JSON.stringify(response))
        console.log(`[agentlet-server] Agentlet registered: ${agentletId}`)
      }
    } catch (err) {
      const response = {
        jsonrpc: '2.0' as const,
        id: msg.id,
        error: { code: ErrorCodes.INVALID_TOKEN, message: err instanceof Error ? err.message : 'Authentication failed' },
      }
      ws.send(JSON.stringify(response))
      ws.close(4001, 'Authentication failed')
    }
  }

  private async handleAgentHello(
    ws: WebSocket,
    token: string,
    msg: { jsonrpc: '2.0'; method: string; id: number; params: Record<string, unknown> }
  ): Promise<void> {
    const params = msg.params as unknown as AgentHelloParams

    // Validate required fields
    if (!params.sessionId || !params.sessionProfile) {
      const response = {
        jsonrpc: '2.0' as const,
        id: msg.id,
        error: { code: ErrorCodes.INVALID_REQUEST, message: 'Missing sessionId or sessionProfile' },
      }
      ws.send(JSON.stringify(response))
      ws.close(4001, 'Invalid agent/hello params')
      return
    }

    try {
      const authResult = await this.options.authenticate(token, params)

      const { sessionId, sessionProfile } = params

      const existingConn = this.connections.get(sessionId)

      if (existingConn) {
        if (existingConn.role !== 'agent-session') {
          const response = {
            jsonrpc: '2.0' as const,
            id: msg.id,
            error: { code: ErrorCodes.DUPLICATE_SESSION, message: `ID "${sessionId}" exists as agentlet` },
          }
          ws.send(JSON.stringify(response))
          ws.close(4002, 'Role mismatch')
          return
        }

        existingConn.handleReconnect(ws)
        this.wireEventPersistence(existingConn)
        this.persistSessionRecord(sessionId, sessionProfile, token, 'active')

        const response = {
          jsonrpc: '2.0' as const,
          id: msg.id,
          result: { sessionId, status: 'connected' } satisfies AgentHelloResult,
        }
        ws.send(JSON.stringify(response))
        existingConn.flushOutboundBuffer()
        this.options.onReconnection?.(existingConn)
      } else {
        const conn = new AgentConnectionImpl({
          sessionId,
          agentletId: sessionProfile.agentletId,
          role: 'agent-session',
          metadata: authResult.metadata ?? {},
          ws,
          outboundBufferLimit: this.outboundBufferLimit,
        })

        this.connections.set(sessionId, conn)
        this.wireEventPersistence(conn)
        this.persistSessionRecord(sessionId, sessionProfile, token, 'active')

        const response = {
          jsonrpc: '2.0' as const,
          id: msg.id,
          result: { sessionId, status: 'connected' } satisfies AgentHelloResult,
        }
        ws.send(JSON.stringify(response))

        console.log(`[agentlet-server] Agent session connected: ${sessionId}`)
        this.options.onConnection?.(conn)
      }
    } catch (err) {
      const response = {
        jsonrpc: '2.0' as const,
        id: msg.id,
        error: { code: ErrorCodes.INVALID_TOKEN, message: err instanceof Error ? err.message : 'Authentication failed' },
      }
      ws.send(JSON.stringify(response))
      ws.close(4001, 'Authentication failed')
    }
  }

  private sendAgentletRequest<T>(conn: AgentConnectionImpl, method: string, params: unknown): Promise<T> {
    const id = ++this.agentletRequestId
    const requestKey = `${conn.sessionId}:${id}`

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(requestKey, { resolve, reject })

      const msg: JsonRpcMessage = {
        jsonrpc: '2.0',
        method,
        id,
        params: params as Record<string, unknown>,
      }
      conn.sendRaw(msg)

      setTimeout(() => {
        if (this.pendingRequests.has(requestKey)) {
          this.pendingRequests.delete(requestKey)
          reject(new Error(`Agentlet request timed out: ${method}`))
        }
      }, 30_000)
    })
  }

  /** Handle JSON-RPC responses to pending agentlet requests */
  private handlePendingResponse(conn: AgentConnectionImpl, msg: JsonRpcMessage): void {
    if (!('id' in msg)) return
    const requestKey = `${conn.sessionId}:${msg.id}`
    const pending = this.pendingRequests.get(requestKey)
    if (!pending) return

    this.pendingRequests.delete(requestKey)
    if ('error' in msg && msg.error) {
      pending.reject(new Error(msg.error.message))
    } else if ('result' in msg) {
      pending.resolve(msg.result)
    }
  }

  private hasPendingRequest(sessionId: string, id: string | number): boolean {
    return this.pendingRequests.has(`${sessionId}:${id}`)
  }

  private findConnectionByWs(ws: WebSocket): AgentConnectionImpl | undefined {
    for (const conn of this.connections.values()) {
      if (conn.hasWs(ws)) return conn
    }
    return undefined
  }

  /** Wire event persistence callback onto an agent-session connection */
  private wireEventPersistence(conn: AgentConnectionImpl): void {
    if (!this.eventStore) return
    const sessionId = conn.sessionId
    const eventStore = this.eventStore
    conn.setPersistCallback((dir, msg) => {
      eventStore.append(sessionId, dir, msg)
    })
  }

  /** Persist session record to DataStore (agent-sessions only) */
  private persistSessionRecord(sessionId: string, profile: SessionProfile, token: string, status: 'active' | 'closed'): void {
    if (!this.dataStore) return
    const now = new Date().toISOString()
    const existing = this.dataStore.getSession(sessionId)
    const owner = tokenSignature(token)
    const command = profile.agent.command ?? existing?.command ?? 'unknown'
    this.dataStore.saveSession({
      sessionId,
      displayName: existing?.displayName || sessionId,
      agentletId: profile.agentletId ?? existing?.agentletId,
      command,
      cwd: profile.agent.cwd ?? existing?.cwd ?? '/',
      env: existing?.env,
      status,
      supportsLoad: profile.session?.supportsLoad ?? false,
      supportsResume: profile.session?.supportsResume ?? false,
      initializeResult: profile.session?.initializeResult ?? null,
      // Preserve a previously-stored session/new blob across resume/load
      // (which never carries one) so the host doesn't lose inline meta.
      newSessionResult: profile.session?.newSessionResult ?? existing?.newSessionResult ?? null,
      owner,
      profile: JSON.stringify(profile),
      idleTimeoutSecs: existing?.idleTimeoutSecs ?? 0,
      autoRestart: profile.capabilities.autoRestart,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
  }

  private persistAgentletRecord(params: AgentletHelloParams, token: string): void {
    if (!this.dataStore) return
    const now = new Date().toISOString()
    const owner = tokenSignature(token)
    this.dataStore.saveAgentlet({
      agentletId: params.agentletId,
      machine: params.agentletProfile.machine,
      bridge: params.agentletProfile.bridge,
      capabilities: params.agentletProfile.capabilities,
      owner,
      registeredAt: now,
      updatedAt: now,
    })
  }
}
