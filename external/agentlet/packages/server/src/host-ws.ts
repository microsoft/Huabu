import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AgentletServer } from './server.js'
import type { EventEntry } from './event-store.js'
import type { AcpMessage, LifecycleEvent, SessionProfile } from '@agentlet/protocol'
import { HostMethods, ServerHostMethods } from '@agentlet/protocol'

/**
 * Host-side WebSocket endpoint (WS /api/host).
 *
 * Uses JSON-RPC 2.0 notifications for all messages (no request/response).
 *
 * Client → Server:
 *   { jsonrpc: "2.0", method: "host/send", params: { sessionId, message } }
 *   { jsonrpc: "2.0", method: "host/subscribe", params: { sessionId, afterSeq? } }
 *   { jsonrpc: "2.0", method: "host/unsubscribe", params: { sessionId } }
 *
 * Server → Client:
 *   { jsonrpc: "2.0", method: "server/event", params: { sessionId, seq, ts, dir, event } }
 *   { jsonrpc: "2.0", method: "server/replayed", params: { sessionId, lastSeq } }
 *   { jsonrpc: "2.0", method: "agent/connected", params: { sessionId, sessionProfile } }
 *   { jsonrpc: "2.0", method: "agent/disconnected", params: { sessionId, reason } }
 *   { jsonrpc: "2.0", method: "agent/exited", params: { sessionId, ... } }
 *   { jsonrpc: "2.0", method: "server/error", params: { sessionId?, code, message } }
 */

/** Per-client subscription state for a single session */
interface SessionSubscription {
  sessionId: string
  unsubscribe: () => void
}

/** Per-client state tracked by the host WS */
interface HostClient {
  ws: WebSocket
  subscriptions: Map<string, SessionSubscription>
}

export class HostWebSocket {
  private readonly wss: WebSocketServer
  private readonly server: AgentletServer
  private readonly clients = new Map<WebSocket, HostClient>()

  constructor(server: AgentletServer) {
    this.server = server
    this.wss = new WebSocketServer({ noServer: true })
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const client: HostClient = { ws, subscriptions: new Map() }
      this.clients.set(ws, client)
      this.onHostClient(client)
    })
  }

  close(): void {
    for (const client of this.clients.values()) {
      for (const sub of client.subscriptions.values()) {
        sub.unsubscribe()
      }
      client.ws.close(1001, 'server_shutting_down')
    }
    this.clients.clear()
    this.wss.close()
  }

  private onHostClient(client: HostClient): void {
    const { ws } = client

    // Send current agent sessions on connect — read profiles from DataStore
    for (const conn of this.server.getAgentSessions()) {
      const dataStore = this.server.getDataStore()
      const sessionRecord = dataStore.getSession(conn.sessionId)
      let profile = undefined
      if (sessionRecord?.profile) {
        try { profile = JSON.parse(sessionRecord.profile) } catch { /* ignore */ }
      }
      this.sendNotification(ws, ServerHostMethods.CONNECTED, {
        sessionId: conn.sessionId,
        sessionProfile: profile,
      })
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) return

      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }

      // JSON-RPC dispatch by method
      const method = msg.method as string | undefined
      const params = (msg.params ?? {}) as Record<string, unknown>

      switch (method) {
        case HostMethods.SEND:
          this.handleSend(client, params)
          break
        case HostMethods.SUBSCRIBE:
          this.handleSubscribe(client, params)
          break
        case HostMethods.UNSUBSCRIBE:
          this.handleUnsubscribe(client, params)
          break
      }
    })

    ws.on('close', () => {
      for (const sub of client.subscriptions.values()) {
        sub.unsubscribe()
      }
      this.clients.delete(ws)
    })

    ws.on('error', () => {
      for (const sub of client.subscriptions.values()) {
        sub.unsubscribe()
      }
      this.clients.delete(ws)
    })
  }

  private handleSend(client: HostClient, params: Record<string, unknown>): void {
    const sessionId = params.sessionId as string | undefined
    const message = params.message as AcpMessage | undefined

    if (!sessionId || !message) {
      this.sendNotification(client.ws, ServerHostMethods.ERROR, {
        code: 'INVALID_REQUEST',
        message: 'Missing sessionId or message',
      })
      return
    }

    const conn = this.server.getConnection(sessionId)
    if (!conn || conn.status !== 'connected') {
      this.sendNotification(client.ws, ServerHostMethods.ERROR, {
        sessionId,
        code: 'NO_ACTIVE_AGENT',
        message: 'No agent is currently connected for this session',
      })
      return
    }

    conn.send(message)
  }

  private handleSubscribe(client: HostClient, params: Record<string, unknown>): void {
    const sessionId = params.sessionId as string | undefined
    const afterSeq = typeof params.afterSeq === 'number' ? params.afterSeq : 0

    if (!sessionId) {
      this.sendNotification(client.ws, ServerHostMethods.ERROR, {
        code: 'INVALID_REQUEST',
        message: 'Missing sessionId for subscribe',
      })
      return
    }

    // Cancel previous subscription if exists
    const existing = client.subscriptions.get(sessionId)
    if (existing) {
      existing.unsubscribe()
      client.subscriptions.delete(sessionId)
    }

    const eventStore = this.server.getEventStore()
    const { ws } = client
    let lastSentSeq = afterSeq
    const liveBuffer: EventEntry[] = []
    let replaying = true

    // 1. Subscribe to live events FIRST (buffer during replay)
    const unsubscribe = eventStore.subscribe(sessionId, (entry) => {
      if (replaying) {
        liveBuffer.push(entry)
      } else if (entry.seq > lastSentSeq) {
        this.sendEvent(ws, sessionId, entry)
        lastSentSeq = entry.seq
      }
    })

    client.subscriptions.set(sessionId, { sessionId, unsubscribe })

    // 2. Replay historical events
    const history = eventStore.getEventsSince(sessionId, afterSeq)
    for (const entry of history) {
      if (ws.readyState !== WebSocket.OPEN) break
      this.sendEvent(ws, sessionId, entry)
      lastSentSeq = entry.seq
    }

    // 3. Drain live buffer
    for (const entry of liveBuffer) {
      if (ws.readyState !== WebSocket.OPEN) break
      if (entry.seq > lastSentSeq) {
        this.sendEvent(ws, sessionId, entry)
        lastSentSeq = entry.seq
      }
    }

    // 4. Switch to live mode
    replaying = false
    this.sendNotification(ws, ServerHostMethods.REPLAYED, { sessionId, lastSeq: lastSentSeq })
  }

  private handleUnsubscribe(client: HostClient, params: Record<string, unknown>): void {
    const sessionId = params.sessionId as string | undefined
    if (!sessionId) return

    const sub = client.subscriptions.get(sessionId)
    if (sub) {
      sub.unsubscribe()
      client.subscriptions.delete(sessionId)
    }
  }

  /** Broadcast a JSON-RPC notification to all connected host clients */
  private broadcastNotification(method: string, params: Record<string, unknown>): void {
    const data = JSON.stringify({ jsonrpc: '2.0', method, params })
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data)
      }
    }
  }

  /** Broadcast agent connected event */
  broadcastConnected(sessionId: string, sessionProfile: SessionProfile): void {
    this.broadcastNotification(ServerHostMethods.CONNECTED, { sessionId, sessionProfile })
  }

  /** Broadcast agent disconnected event */
  broadcastDisconnected(sessionId: string, reason: string): void {
    this.broadcastNotification(ServerHostMethods.DISCONNECTED, { sessionId, reason })
  }

  /** Broadcast a lifecycle event (flattened — uses the event's own type as method) */
  broadcastLifecycle(sessionId: string, event: LifecycleEvent): void {
    // event.type is already in entity/verb format: 'agent/exited', 'agent/restarted', etc.
    this.broadcastNotification(event.type, { sessionId, ...event })
  }

  private sendEvent(ws: WebSocket, sessionId: string, entry: EventEntry): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: ServerHostMethods.EVENT,
        params: {
          sessionId,
          seq: entry.seq,
          ts: entry.ts,
          dir: entry.dir,
          event: entry.event,
        },
      }))
    }
  }

  private sendNotification(ws: WebSocket, method: string, params: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
    }
  }
}
