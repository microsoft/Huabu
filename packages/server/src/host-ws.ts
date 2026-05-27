import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AgentletServer } from './server.js'
import type { AcpMessage } from '@agentlet/protocol'

/**
 * Host-side WebSocket endpoint (WS /api/host).
 *
 * Envelope protocol:
 *   Host → Server: { type: "send", agentId: string, message: AcpMessage }
 *   Server → Host: { type: "message", agentId: string, message: AcpMessage }
 *   Server → Host: { type: "connected", agentId: string, agentInfo: {...} }
 *   Server → Host: { type: "disconnected", agentId: string, reason: string }
 *   Server → Host: { type: "lifecycle", agentId: string, event: {...} }
 */
export class HostWebSocket {
  private readonly wss: WebSocketServer
  private readonly server: AgentletServer
  private readonly clients = new Set<WebSocket>()

  constructor(server: AgentletServer) {
    this.server = server
    this.wss = new WebSocketServer({ noServer: true })

    // Listen for new agent connections and broadcast to all host clients
    this.setupServerListeners()
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.clients.add(ws)
      this.onHostClient(ws)
    })
  }

  close(): void {
    for (const client of this.clients) {
      client.close(1001, 'server_shutting_down')
    }
    this.clients.clear()
    this.wss.close()
  }

  private onHostClient(ws: WebSocket): void {
    // Send current agent list on connect
    for (const agent of this.server.getConnections()) {
      const msg = {
        type: 'connected',
        agentId: agent.agentId,
        agentInfo: agent.agentInfo,
        machine: agent.machine,
        status: agent.status,
      }
      ws.send(JSON.stringify(msg))
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) return

      let envelope: { type?: string; agentId?: string; message?: AcpMessage }
      try {
        envelope = JSON.parse(data.toString())
      } catch {
        return
      }

      if (envelope.type === 'send' && envelope.agentId && envelope.message) {
        const conn = this.server.getConnection(envelope.agentId)
        if (conn && conn.status === 'connected') {
          conn.send(envelope.message)
        }
      }
    })

    ws.on('close', () => {
      this.clients.delete(ws)
    })

    ws.on('error', () => {
      this.clients.delete(ws)
    })
  }

  /** Broadcast an envelope message to all connected host clients */
  broadcast(envelope: unknown): void {
    const data = JSON.stringify(envelope)
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data)
      }
    }
  }

  private setupServerListeners(): void {
    // These are set up via the standalone wiring (onConnection/onDisconnection callbacks)
    // The standalone.ts wires AgentletServerOptions callbacks to call broadcast()
  }
}
