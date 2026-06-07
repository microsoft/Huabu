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
  private active = false

  constructor(agent: AgentProcess, ws: WsClient, logger: Logger, options?: RelayOptions) {
    super()
    this.agent = agent
    this.ws = ws
    this.logger = logger
    this.idleTimeoutMs = (options?.idleTimeoutSecs ?? 0) * 1000
  }

  /** Start relaying messages bidirectionally */
  start(): void {
    if (this.active) return
    this.active = true

    // Agent stdout → WebSocket
    this.agent.on('message', (data) => {
      if (!this.active) return

      const msg = data as JsonRpcMessage
      if (!this.isValidJsonRpc(msg)) {
        this.logger.warn('invalid_agent_message', { reason: 'not a valid JSON-RPC message' })
        return
      }

      this.logger.debug('relay_agent_to_ws', { method: (msg as unknown as Record<string, unknown>).method, id: (msg as unknown as Record<string, unknown>).id })
      const sent = this.ws.send(msg)
      if (!sent) {
        this.logger.warn('ws_send_failed', { reason: 'WebSocket not connected' })
      }
    })

    // WebSocket → Agent stdin (host-to-agent direction — resets idle timer)
    this.ws.on('message', (msg) => {
      if (!this.active) return

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
  }

  private resetIdleTimer(): void {
    if (!this.idleTimeoutMs || !this.active) return
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      if (!this.active) return
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

  private isValidJsonRpc(msg: unknown): msg is JsonRpcMessage {
    if (typeof msg !== 'object' || msg === null) return false
    const obj = msg as Record<string, unknown>
    return obj['jsonrpc'] === '2.0'
  }
}
