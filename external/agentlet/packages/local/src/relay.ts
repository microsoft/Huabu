import type { JsonRpcMessage } from '@agentlet/protocol'
import { AgentProcess } from './agent-process.js'
import { WsClient } from './ws-client.js'
import { Logger } from './logger.js'
import { EventEmitter } from 'node:events'

export interface RelayOptions {
  /**
   * Idle timeout in seconds. Counts inactivity from host-to-agent direction only
   * (server→agent messages). 0 or omitted = no timeout.
   */
  idleTimeoutSecs?: number
}

/**
 * Relay wires the agent process and WebSocket client together:
 * - Agent stdout (parsed JSON) → WebSocket send
 * - WebSocket message → Agent stdin
 *
 * Also tracks idle time based on host-to-agent message flow.
 * Emits 'idle' when the idle timeout fires.
 */
export class Relay extends EventEmitter {
  private readonly agent: AgentProcess
  private readonly ws: WsClient
  private readonly logger: Logger
  private readonly idleTimeoutMs: number
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pendingHostRequests = new Set<string | number>()
  private active = false

  constructor(agent: AgentProcess, ws: WsClient, logger: Logger, options?: RelayOptions) {
    super()
    this.agent = agent
    this.ws = ws
    this.logger = logger
    this.idleTimeoutMs = (options?.idleTimeoutSecs ?? 0) * 1000
  }

  /**
   * Start relaying messages bidirectionally.
   *
   * @param replay Agent messages captured before the relay attached (e.g.
   *   notifications the agent emitted in the window between `session/new`
   *   completing and this relay starting — Copilot pushes
   *   `available_commands_update` there). They are flushed to the host in
   *   order before live relaying begins so no early notification is lost.
   */
  start(replay: JsonRpcMessage[] = []): void {
    if (this.active) return
    this.active = true

    // Flush buffered early messages first so the host sees them in arrival
    // order, ahead of any live message produced after this point.
    for (const msg of replay) {
      if (!this.isValidJsonRpc(msg)) {
        this.logger.warn('invalid_agent_message', { reason: 'buffered message is not valid JSON-RPC' })
        continue
      }
      this.logger.debug('relay_replay_to_ws', { method: (msg as unknown as Record<string, unknown>).method, id: (msg as unknown as Record<string, unknown>).id })
      const sent = this.ws.send(msg)
      if (!sent) {
        this.logger.warn('ws_send_failed', { reason: 'WebSocket not connected (replay)' })
      }
    }

    // Agent stdout → WebSocket
    this.agent.on('message', (data) => {
      if (!this.active) return

      const msg = data as JsonRpcMessage
      if (!this.isValidJsonRpc(msg)) {
        this.logger.warn('invalid_agent_message', { reason: 'not a valid JSON-RPC message' })
        return
      }

      this.completeHostRequest(msg)
      this.logger.debug('relay_agent_to_ws', { method: (msg as unknown as Record<string, unknown>).method, id: (msg as unknown as Record<string, unknown>).id })
      const sent = this.ws.send(msg)
      if (!sent) {
        this.logger.warn('ws_send_failed', { reason: 'WebSocket not connected' })
      }
    })

    // WebSocket → Agent stdin (host-to-agent direction — resets idle timer)
    this.ws.on('message', (msg) => {
      if (!this.active) return

      this.trackHostRequest(msg)
      this.resetIdleTimer()
      this.logger.debug('relay_ws_to_agent', { method: (msg as unknown as Record<string, unknown>).method, id: (msg as unknown as Record<string, unknown>).id })
      const written = this.agent.write(msg)
      if (!written) {
        this.logger.warn('agent_write_failed', { reason: 'Agent stdin not writable' })
      }
    })

    // Start idle timer if configured
    this.resetIdleTimer()
  }

  /** Stop relaying and clear idle timer */
  stop(): void {
    this.active = false
    this.clearIdleTimer()
    this.pendingHostRequests.clear()
  }

  private resetIdleTimer(): void {
    if (!this.idleTimeoutMs || !this.active) return
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.active) return
      if (this.pendingHostRequests.size > 0) {
        this.logger.debug('relay_idle_deferred', {
          pendingHostRequests: this.pendingHostRequests.size,
        })
        return
      }
      this.logger.info('relay_idle_timeout', { timeoutSecs: this.idleTimeoutMs / 1000 })
      this.emit('idle')
    }, this.idleTimeoutMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private trackHostRequest(msg: JsonRpcMessage): void {
    if ('method' in msg && 'id' in msg) {
      this.pendingHostRequests.add(msg.id)
    }
  }

  private completeHostRequest(msg: JsonRpcMessage): void {
    if ('method' in msg || !('id' in msg)) return
    if (this.pendingHostRequests.delete(msg.id)) {
      this.resetIdleTimer()
    }
  }

  private isValidJsonRpc(msg: unknown): msg is JsonRpcMessage {
    if (typeof msg !== 'object' || msg === null) return false
    const obj = msg as Record<string, unknown>
    return obj['jsonrpc'] === '2.0'
  }
}
