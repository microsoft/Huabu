import type { JsonRpcMessage } from '@agentlet/protocol'
import { AgentProcess } from './agent-process.js'
import { WsClient } from './ws-client.js'
import { Logger } from './logger.js'

/**
 * Relay wires the agent process and WebSocket client together:
 * - Agent stdout (parsed JSON) → WebSocket send
 * - WebSocket message → Agent stdin
 *
 * Pure transparent relay — no message inspection or transformation.
 * Session lifecycle is owned by the bootstrap phase, not the relay.
 */
export class Relay {
  private readonly agent: AgentProcess
  private readonly ws: WsClient
  private readonly logger: Logger
  private active = false

  constructor(agent: AgentProcess, ws: WsClient, logger: Logger) {
    this.agent = agent
    this.ws = ws
    this.logger = logger
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

    // WebSocket → Agent stdin
    this.ws.on('message', (msg) => {
      if (!this.active) return

      this.logger.debug('relay_ws_to_agent', { method: (msg as unknown as Record<string, unknown>).method, id: (msg as unknown as Record<string, unknown>).id })
      const written = this.agent.write(msg)
      if (!written) {
        this.logger.warn('agent_write_failed', { reason: 'Agent stdin not writable' })
      }
    })
  }

  /** Stop relaying */
  stop(): void {
    this.active = false
  }

  private isValidJsonRpc(msg: unknown): msg is JsonRpcMessage {
    if (typeof msg !== 'object' || msg === null) return false
    const obj = msg as Record<string, unknown>
    return obj['jsonrpc'] === '2.0'
  }
}
