import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AgentletServer } from './server.js'
import type { SessionMap } from './session-map.js'
import type { TokenStore } from './token-store.js'
import type { AcpMessage } from '@agentlet/protocol'

interface ClientState {
  ws: WebSocket
  agentId: string
  token: string
  // Track pending request IDs for session interception
  pendingSessionRequestId: number | string | null
  isSessionLoad: boolean // true if we rewrote session/new → session/load
}

/**
 * Per-agent raw ACP WebSocket endpoint (WS /agents/:agentId/ws).
 *
 * Each connection speaks raw ACP JSON-RPC — no envelope protocol.
 * The server transparently bridges between this endpoint and the
 * internal agent connection. Supports multiple simultaneous clients
 * per agent (e.g., UI + external tool).
 *
 * Also handles session tracking: intercepts session/new and rewrites
 * to session/load when a stored session exists for this (token, agent).
 */
export class AgentWebSocket {
  private readonly wss: WebSocketServer
  private readonly server: AgentletServer
  private readonly sessionMap: SessionMap
  private readonly tokenStore: TokenStore
  // Map agentId → set of connected host clients for that agent
  private readonly agentClients = new Map<string, Set<WebSocket>>()
  // Per-WS client state for session interception
  private readonly clientState = new Map<WebSocket, ClientState>()

  constructor(server: AgentletServer, sessionMap: SessionMap, tokenStore: TokenStore) {
    this.server = server
    this.sessionMap = sessionMap
    this.tokenStore = tokenStore
    this.wss = new WebSocketServer({ noServer: true })
  }

  /**
   * Handle upgrade for /agents/:agentId/ws.
   * The agentId must be extracted from the URL before calling this.
   * Token is extracted from ?token= query param.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, agentId: string): void {
    const conn = this.server.getConnection(agentId)
    if (!conn || conn.status !== 'connected') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    // Extract token from query param
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const token = url.searchParams.get('token') ?? ''

    // Validate token
    if (token && !this.tokenStore.validate(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // Verify token matches the agent's token (user can only access their own agents)
    if (token && conn.token !== token) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onClient(ws, agentId, token)
    })
  }

  close(): void {
    for (const clients of this.agentClients.values()) {
      for (const ws of clients) {
        ws.close(1001, 'server_shutting_down')
      }
    }
    this.agentClients.clear()
    this.wss.close()
  }

  /**
   * Called by standalone wiring when an agent sends an ACP message.
   * Fans out to all raw WS clients subscribed to that agent.
   * Also intercepts session/new and session/load responses to track sessionId.
   */
  broadcastToAgent(agentId: string, message: AcpMessage): void {
    const clients = this.agentClients.get(agentId)
    if (!clients || clients.size === 0) {
      console.log(`[agent-ws] Agent→UI (${agentId}): no clients to broadcast to`)
      return
    }

    const data = JSON.stringify(message)
    console.log(`[agent-ws] Agent→UI (${agentId}, ${clients.size} clients):`, data.slice(0, 200))

    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue

      // Check if this response matches a pending session request
      const state = this.clientState.get(ws)
      if (state && state.pendingSessionRequestId !== null) {
        const msg = message as unknown as Record<string, unknown>
        if (msg.id === state.pendingSessionRequestId && msg.result) {
          const result = msg.result as Record<string, unknown>
          if (typeof result.sessionId === 'string') {
            this.sessionMap.set(state.token, agentId, result.sessionId)
            console.log(`[agent-ws] Session stored: token=${state.token.slice(0, 8)}... agent=${agentId} session=${result.sessionId}`)
          }
          state.pendingSessionRequestId = null
          state.isSessionLoad = false
        }
        // If session/load failed, clear state and let UI handle error
        if (msg.id === state.pendingSessionRequestId && msg.error) {
          if (state.isSessionLoad) {
            // session/load failed — clear stored session so next attempt does session/new
            this.sessionMap.delete(state.token, agentId)
            console.log(`[agent-ws] session/load failed, cleared stored session for agent=${agentId}`)
          }
          state.pendingSessionRequestId = null
          state.isSessionLoad = false
        }
      }

      ws.send(data)
    }
  }

  /** Remove all clients for a disconnected agent */
  handleAgentDisconnected(agentId: string): void {
    const clients = this.agentClients.get(agentId)
    if (clients) {
      for (const ws of clients) {
        ws.close(1001, 'agent_disconnected')
      }
      this.agentClients.delete(agentId)
    }
  }

  private onClient(ws: WebSocket, agentId: string, token: string): void {
    // Track this client
    if (!this.agentClients.has(agentId)) {
      this.agentClients.set(agentId, new Set())
    }
    this.agentClients.get(agentId)!.add(ws)

    const state: ClientState = {
      ws,
      agentId,
      token,
      pendingSessionRequestId: null,
      isSessionLoad: false,
    }
    this.clientState.set(ws, state)

    console.log(`[agent-ws] Client connected for agent: ${agentId} (total: ${this.agentClients.get(agentId)!.size})`)

    // Forward raw ACP messages from client → agent (with session interception)
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(4002, 'Binary frames not supported')
        return
      }

      const conn = this.server.getConnection(agentId)
      if (!conn || conn.status !== 'connected') {
        console.log(`[agent-ws] Agent ${agentId} not connected, closing client`)
        ws.close(1001, 'agent_disconnected')
        return
      }

      let msg: AcpMessage
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return // skip invalid JSON
      }

      // Intercept session/new: rewrite to session/load if we have a stored session
      const rpcMsg = msg as unknown as Record<string, unknown>
      if (rpcMsg.method === 'session/new' && token) {
        const storedSessionId = this.sessionMap.get(token, agentId)
        if (storedSessionId) {
          // Rewrite to session/load
          rpcMsg.method = 'session/load'
          const params = (rpcMsg.params ?? {}) as Record<string, unknown>
          params.sessionId = storedSessionId
          rpcMsg.params = params
          state.pendingSessionRequestId = rpcMsg.id as number | string
          state.isSessionLoad = true
          console.log(`[agent-ws] Rewrote session/new → session/load (sessionId=${storedSessionId})`)
        } else {
          // Track session/new so we can capture the sessionId from response
          state.pendingSessionRequestId = rpcMsg.id as number | string
          state.isSessionLoad = false
        }
      }

      console.log(`[agent-ws] UI→Agent (${agentId}):`, JSON.stringify(msg).slice(0, 200))
      conn.send(msg)
    })

    ws.on('close', () => {
      const clients = this.agentClients.get(agentId)
      if (clients) {
        clients.delete(ws)
        if (clients.size === 0) {
          this.agentClients.delete(agentId)
        }
      }
      this.clientState.delete(ws)
    })

    ws.on('error', () => {
      const clients = this.agentClients.get(agentId)
      clients?.delete(ws)
      this.clientState.delete(ws)
    })
  }
}
