import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AgentletServer } from './server.js'
import type { TokenStore } from './token-store.js'
import type { AcpMessage } from '@agentlet/protocol'

/**
 * Per-session raw ACP WebSocket endpoint (WS /agents/:sessionId/ws).
 *
 * Each connection speaks raw ACP JSON-RPC — no envelope protocol.
 * The server transparently bridges between this endpoint and the
 * internal agent connection. Supports multiple simultaneous clients
 * per session (e.g., UI + external tool).
 *
 * Pure transparent relay — no ACP-level inspection or rewriting.
 * Session lifecycle is owned by the agentlet (agent-side adapter).
 */
export class AgentWebSocket {
  private readonly wss: WebSocketServer
  private readonly server: AgentletServer
  private readonly tokenStore: TokenStore
  // Map sessionId → set of connected host clients for that session
  private readonly sessionClients = new Map<string, Set<WebSocket>>()

  constructor(server: AgentletServer, tokenStore: TokenStore) {
    this.server = server
    this.tokenStore = tokenStore
    this.wss = new WebSocketServer({ noServer: true })
  }

  /**
   * Handle upgrade for /agents/:sessionId/ws.
   * The sessionId must be extracted from the URL before calling this.
   * Token is extracted from ?token= query param.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, sessionId: string): void {
    const conn = this.server.getConnection(sessionId)
    if (!conn || conn.status !== 'connected') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    // Extract token from query param
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const token = url.searchParams.get('token') ?? ''

    // Validate token via TokenStore
    if (token && !this.tokenStore.validate(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onClient(ws, sessionId)
    })
  }

  close(): void {
    for (const clients of this.sessionClients.values()) {
      for (const ws of clients) {
        ws.close(1001, 'server_shutting_down')
      }
    }
    this.sessionClients.clear()
    this.wss.close()
  }

  /**
   * Called by standalone wiring when an agent sends an ACP message.
   * Fans out to all raw WS clients subscribed to that session.
   * Pure transparent relay — no inspection.
   */
  broadcastToAgent(sessionId: string, message: AcpMessage): void {
    const clients = this.sessionClients.get(sessionId)
    if (!clients || clients.size === 0) {
      console.log(`[agent-ws] Agent→UI (${sessionId}): no clients to broadcast to`)
      return
    }

    const data = JSON.stringify(message)
    console.log(`[agent-ws] Agent→UI (${sessionId}, ${clients.size} clients):`, data.slice(0, 200))

    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    }
  }

  /** Remove all clients for a disconnected session */
  handleAgentDisconnected(sessionId: string): void {
    const clients = this.sessionClients.get(sessionId)
    if (clients) {
      for (const ws of clients) {
        ws.close(1001, 'agent_disconnected')
      }
      this.sessionClients.delete(sessionId)
    }
  }

  private onClient(ws: WebSocket, sessionId: string): void {
    // Track this client
    if (!this.sessionClients.has(sessionId)) {
      this.sessionClients.set(sessionId, new Set())
    }
    this.sessionClients.get(sessionId)!.add(ws)

    console.log(`[agent-ws] Client connected for agent: ${sessionId} (total: ${this.sessionClients.get(sessionId)!.size})`)

    // Forward raw ACP messages from client → agent (transparent relay)
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(4002, 'Binary frames not supported')
        return
      }

      const conn = this.server.getConnection(sessionId)
      if (!conn || conn.status !== 'connected') {
        console.log(`[agent-ws] Agent ${sessionId} not connected, closing client`)
        ws.close(1001, 'agent_disconnected')
        return
      }

      let msg: AcpMessage
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return // skip invalid JSON
      }

      console.log(`[agent-ws] UI→Agent (${sessionId}):`, JSON.stringify(msg).slice(0, 200))
      conn.send(msg)
    })

    ws.on('close', () => {
      const clients = this.sessionClients.get(sessionId)
      if (clients) {
        clients.delete(ws)
        if (clients.size === 0) {
          this.sessionClients.delete(sessionId)
        }
      }
    })

    ws.on('error', () => {
      const clients = this.sessionClients.get(sessionId)
      clients?.delete(ws)
    })
  }
}
