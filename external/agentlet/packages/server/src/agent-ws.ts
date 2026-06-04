import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AgentletServer } from './server.js'
import type { TokenStore } from './token-store.js'
import type { AcpMessage } from '@agentlet/protocol'

/**
 * Per-agent raw ACP WebSocket endpoint (WS /agents/:agentId/ws).
 *
 * Each connection speaks raw ACP JSON-RPC — no envelope protocol.
 * The server transparently bridges between this endpoint and the
 * internal agent connection. Supports multiple simultaneous clients
 * per agent (e.g., UI + external tool).
 *
 * Pure transparent relay — no ACP-level inspection or rewriting.
 * Session lifecycle is owned by the agentlet (agent-side adapter).
 */
export class AgentWebSocket {
  private readonly wss: WebSocketServer
  private readonly server: AgentletServer
  private readonly tokenStore: TokenStore
  // Map agentId → set of connected host clients for that agent
  private readonly agentClients = new Map<string, Set<WebSocket>>()

  constructor(server: AgentletServer, tokenStore: TokenStore) {
    this.server = server
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
   * Pure transparent relay — no inspection.
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
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
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

    console.log(`[agent-ws] Client connected for agent: ${agentId} (total: ${this.agentClients.get(agentId)!.size})`)

    // Forward raw ACP messages from client → agent (transparent relay)
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
    })

    ws.on('error', () => {
      const clients = this.agentClients.get(agentId)
      clients?.delete(ws)
    })
  }
}
