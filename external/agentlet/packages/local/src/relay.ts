import path from 'node:path'
import type { JsonRpcMessage } from '@agentlet/protocol'
import { AgentProcess } from './agent-process.js'
import { WsClient } from './ws-client.js'
import { Logger } from './logger.js'

/**
 * Relay wires the agent process and WebSocket client together:
 * - Agent stdout (parsed JSON) → WebSocket send
 * - WebSocket message → Agent stdin
 *
 * Also intercepts session/new to inject local context (cwd).
 */
export class Relay {
  private readonly agent: AgentProcess
  private readonly ws: WsClient
  private readonly logger: Logger
  private readonly cwd: string
  private active = false

  constructor(agent: AgentProcess, ws: WsClient, logger: Logger) {
    this.agent = agent
    this.ws = ws
    this.logger = logger
    this.cwd = path.resolve(process.cwd())
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

    // WebSocket → Agent stdin (with session/new interception)
    this.ws.on('message', (msg) => {
      if (!this.active) return

      const enriched = this.enrichMessage(msg)
      this.logger.debug('relay_ws_to_agent', { method: (enriched as unknown as Record<string, unknown>).method, id: (enriched as unknown as Record<string, unknown>).id })
      const written = this.agent.write(enriched)
      if (!written) {
        this.logger.warn('agent_write_failed', { reason: 'Agent stdin not writable' })
      }
    })
  }

  /** Stop relaying */
  stop(): void {
    this.active = false
  }

  /**
   * Intercept session/new and session/load requests to inject local cwd.
   * The remote UI doesn't know (or control) the local working directory,
   * so the relay injects it as the local authority.
   */
  private enrichMessage(msg: JsonRpcMessage): JsonRpcMessage {
    const obj = msg as unknown as Record<string, unknown>
    if ((obj.method === 'session/new' || obj.method === 'session/load') && obj.params) {
      const params = obj.params as Record<string, unknown>
      if (!params.cwd || params.cwd === '/') {
        params.cwd = this.cwd
        this.logger.info('session_enriched', { method: obj.method, cwd: this.cwd })
      }
      if (!params.mcpServers) {
        params.mcpServers = []
      }
    }
    return msg
  }

  private isValidJsonRpc(msg: unknown): msg is JsonRpcMessage {
    if (typeof msg !== 'object' || msg === null) return false
    const obj = msg as Record<string, unknown>
    return obj['jsonrpc'] === '2.0'
  }
}
