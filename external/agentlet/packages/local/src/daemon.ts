import { hostname, platform } from 'node:os'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  AgentletMethods,
  AgentMethods,
  ServerMethods,
  PROTOCOL_VERSION,
  type AgentletHelloParams,
  type AgentletProfile,
  type AgentHelloParams,
  type AgentHelloResult,
  type SpawnParams,
  type StopParams,
  type JsonRpcMessage,
} from '@agentlet/protocol'
import { AgentProcess } from './agent-process.js'
import { WsClient } from './ws-client.js'
import { Relay } from './relay.js'
import { Logger } from './logger.js'
import { bootstrapSession, type SessionProfile as BootstrapProfile } from './session-bootstrap.js'
import type { DaemonOptions } from './cli.js'

interface ManagedAgent {
  sessionId: string
  command: string
  cwd: string
  pid: number
  agent: AgentProcess
  ws: WsClient
  relay: Relay | null
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'suspending'
  sessionProfile: BootstrapProfile
  idleTimeoutSecs: number
  /** Set to true when idle suspension is in progress — suppresses autoRestart */
  idleSuspending: boolean
}

function defaultDaemonId(): string {
  return hostname()
}

/**
 * Upper bound on the early-message buffer (notifications collected between
 * bootstrap completing and the relay attaching). If the WS handshake stalls,
 * this prevents unbounded memory growth from streamed agent output.
 */
const EARLY_MESSAGE_BUFFER_CAP = 1000

export class Daemon {
  private readonly options: DaemonOptions
  private readonly logger: Logger
  private readonly daemonId: string
  private ws: WebSocket | null = null
  private readonly agents = new Map<string, ManagedAgent>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shutdownInProgress = false
  private handshakeComplete = false

  constructor(options: DaemonOptions, logger: Logger) {
    this.options = options
    this.logger = logger
    this.daemonId = options.daemonId ?? defaultDaemonId()
  }

  async start(): Promise<void> {
    this.setupSignalHandlers()
    this.logger.info('daemon_starting', { daemonId: this.daemonId })
    this.connect()
  }

  private connect(): void {
    if (!this.options.allowInsecure && !this.options.server.startsWith('wss://')) {
      this.logger.error('insecure_url', {
        message: `Server URL must use wss:// (got ${this.options.server}). Use --allow-insecure for local development.`,
      })
      process.exit(1)
    }

    this.handshakeComplete = false
    // Add token and role to WS URL query params
    const url = new URL(this.options.server)
    if (this.options.token) {
      url.searchParams.set('token', this.options.token)
    }
    url.searchParams.set('role', 'agentlet')
    url.searchParams.set('id', this.daemonId)
    this.ws = new WebSocket(url.toString())

    this.ws.on('open', () => {
      this.logger.info('ws_connected', { server: this.options.server })
      this.sendDaemonHello()
    })

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.logger.error('binary_frame', { message: 'Received binary WebSocket frame' })
        return
      }
      const text = data.toString()
      try {
        const msg = JSON.parse(text) as JsonRpcMessage
        this.handleMessage(msg)
      } catch {
        this.logger.error('invalid_json', { text: text.slice(0, 200) })
      }
    })

    this.ws.on('close', (code, reason) => {
      if (this.shutdownInProgress) return
      this.logger.warn('ws_disconnected', { code, reason: reason.toString() })
      this.ws = null
      this.handshakeComplete = false
      this.startReconnection()
    })

    this.ws.on('error', (err) => {
      this.logger.error('ws_error', { message: err.message })
    })
  }

  private sendDaemonHello(): void {
    const agentletProfile: AgentletProfile = {
      bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
      machine: { hostname: hostname(), platform: platform() },
      capabilities: {
        autoRestart: true,
        bufferLimit: this.options.bufferLimit,
        maxAgents: this.options.maxAgents,
      },
    }
    const params: AgentletHelloParams = {
      agentletId: this.daemonId,
      agentletProfile,
    }
    // Token in query param — add it to the URL before connecting
    const hello: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: AgentletMethods.HELLO,
      id: 1,
      params: params as unknown as Record<string, unknown>,
    }
    this.ws?.send(JSON.stringify(hello))
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Handle handshake response
    if (!this.handshakeComplete && 'id' in msg && msg.id === 1) {
      if ('error' in msg && msg.error) {
        this.logger.error('handshake_failed', { code: msg.error.code, message: msg.error.message })
        this.shutdown('handshake_failed')
        return
      }
      if ('result' in msg) {
        const result = msg.result as AgentHelloResult
        this.handshakeComplete = true
        this.reconnectAttempt = 0
        this.logger.info('daemon_ready', { daemonId: result.sessionId, agents: this.agents.size })
        return
      }
    }

    // Handle control commands from server
    if ('method' in msg && 'id' in msg) {
      this.handleRequest(msg as { jsonrpc: '2.0'; method: string; id: string | number; params?: Record<string, unknown> })
      return
    }

    // Handle notifications (e.g., bridge/shutdown)
    if ('method' in msg && !('id' in msg)) {
      if (msg.method === ServerMethods.SHUTDOWN) {
        this.logger.info('shutdown_requested', { params: msg.params })
        this.shutdown('server_requested')
      }
    }
  }

  private handleRequest(msg: { jsonrpc: '2.0'; method: string; id: string | number; params?: Record<string, unknown> }): void {
    switch (msg.method) {
      case ServerMethods.SPAWN:
        this.handleSpawn(msg.id, msg.params as unknown as SpawnParams)
        break
      case ServerMethods.STOP:
        this.handleStop(msg.id, msg.params as unknown as StopParams)
        break
      case ServerMethods.LIST:
        this.handleList(msg.id)
        break
      default:
        this.sendResponse(msg.id, undefined, { code: -32601, message: `Unknown method: ${msg.method}` })
    }
  }

  private async handleSpawn(requestId: string | number, params: SpawnParams): Promise<void> {
    const sessionSpec = params?.sessionSpec
    if (!sessionSpec?.command) {
      this.sendResponse(requestId, undefined, { code: -32602, message: 'Missing required param: sessionSpec.command' })
      return
    }

    if (this.options.maxAgents && this.agents.size >= this.options.maxAgents) {
      this.sendResponse(requestId, undefined, { code: -32000, message: `Max agents reached (${this.options.maxAgents})` })
      return
    }

    // Validate cwd: must be non-empty if provided, must exist on this machine
    let cwd: string
    if (sessionSpec.cwd && sessionSpec.cwd.trim()) {
      cwd = resolve(sessionSpec.cwd.trim())
      if (!existsSync(cwd)) {
        this.sendResponse(requestId, undefined, {
          code: -32602,
          message: `cwd directory does not exist on this machine: ${cwd}`,
        })
        return
      }
    } else {
      cwd = process.cwd()
    }

    const autoRestart = sessionSpec.autoRestart ?? false

    this.logger.info('spawning_agent', { command: sessionSpec.command, cwd, sessionId: params.sessionId })

    try {
      // Spawn the agent process
      const agent = new AgentProcess({
        command: sessionSpec.command,
        cwd,
        env: sessionSpec.env,
      })

      agent.on('error', (err) => {
        this.logger.error('agent_error', { command: sessionSpec.command, message: err.message })
      })

      agent.on('stderr', (line) => {
        this.logger.debug('agent_stderr', { command: sessionSpec.command, line })
      })

      agent.start()
      const pid = agent.pid ?? 0

      // Session bootstrap: initialize + session lifecycle
      let bootstrap: BootstrapProfile
      try {
        bootstrap = await bootstrapSession(agent, {
          cwd,
          sessionId: params.sessionId,
        }, this.logger)
      } catch (err) {
        this.logger.error('session_bootstrap_failed', { message: err instanceof Error ? err.message : String(err) })
        agent.terminate()
        this.sendResponse(requestId, undefined, {
          code: -32000,
          message: `Session bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }

      const sessionId = bootstrap.sessionId

      // Buffer agent messages emitted between bootstrap completing and the
      // relay attaching. Agents (e.g. Copilot) push `available_commands_update`
      // as a `session/update` notification immediately after `session/new`
      // returns; without this buffer that notification lands in a window with
      // no 'message' listener and is silently dropped, so the host never learns
      // the slash commands. The relay flushes these on start (see relay.start).
      //
      // The notification can also arrive *during* session/new (within ~1ms of
      // its response, sometimes just before it). Those are captured by the
      // bootstrap itself and seeded here so they're replayed too.
      //
      // The buffer is capped (FIFO drop) so a stalled handshake cannot leak
      // unbounded memory, and the listener is detached idempotently from every
      // teardown path (handshake ok/error, agent exit) to avoid leaks.
      const earlyMessages: JsonRpcMessage[] = Array.isArray(bootstrap.bootstrapNotifications)
        ? [...bootstrap.bootstrapNotifications]
        : []
      let earlyDropped = 0
      const bufferEarlyMessage = (data: unknown) => {
        if (earlyMessages.length >= EARLY_MESSAGE_BUFFER_CAP) {
          earlyMessages.shift()
          earlyDropped++
          // Log on first drop and then sparsely so noisy stalls don't spam.
          if (earlyDropped === 1 || earlyDropped % 100 === 0) {
            this.logger.warn('early_message_buffer_overflow', {
              sessionId: bootstrap.sessionId,
              dropped: earlyDropped,
              cap: EARLY_MESSAGE_BUFFER_CAP,
            })
          }
        }
        earlyMessages.push(data as JsonRpcMessage)
      }
      let earlyBufferDetached = false
      const detachEarlyBuffer = () => {
        if (earlyBufferDetached) return
        earlyBufferDetached = true
        agent.removeListener('message', bufferEarlyMessage)
      }
      agent.on('message', bufferEarlyMessage)

      const managed: ManagedAgent = {
        sessionId,
        command: sessionSpec.command,
        cwd,
        pid,
        agent,
        ws: null!,
        relay: null,
        status: 'starting',
        sessionProfile: bootstrap,
        idleTimeoutSecs: sessionSpec.idleTimeoutSecs ?? 0,
        idleSuspending: false,
      }

      agent.on('exit', (code, signal) => {
        this.logger.info('agent_exited', { sessionId, code, signal })
        managed.status = 'stopped'
        // Drop the early-message buffer listener if the agent exits before
        // handshake_ok (idempotent if already detached).
        detachEarlyBuffer()

        // Notify the agent's own WS connection
        if (managed.ws?.connected) {
          const exitNotification: JsonRpcMessage = {
            jsonrpc: '2.0',
            method: AgentMethods.EXITED,
            params: { code, signal, willRestart: autoRestart && code !== 0 && !managed.idleSuspending },
          }
          managed.ws.send(exitNotification)
        }

        // Suppress autoRestart if this exit was caused by idle suspension
        if (autoRestart && code !== 0 && !this.shutdownInProgress && !managed.idleSuspending) {
          this.logger.info('agent_restarting', { sessionId })
          setTimeout(() => {
            if (this.agents.has(sessionId) && !this.shutdownInProgress) {
              agent.start()
              managed.pid = agent.pid ?? 0
              managed.status = 'running'
              this.logger.info('agent_restarted', { sessionId, pid: managed.pid })
            }
          }, 2000)
        } else {
          // Clean up the agent's bridge connection
          managed.relay?.stop()
          managed.ws?.close()
          this.agents.delete(sessionId)
        }
      })

      this.agents.set(sessionId, managed)

      // Open a new bridge WS connection for this agent
      const agentWs = new WsClient({
        serverUrl: this.options.server,
        token: this.options.token,
        sessionId,
        role: 'session',
        agentletId: this.daemonId,
        agent: {
          command: sessionSpec.command,
          pid: managed.pid,
          cwd,
        },
        session: bootstrap,
        capabilities: { autoRestart, bufferLimit: this.options.bufferLimit },
        heartbeatInterval: this.options.heartbeat,
        allowInsecure: this.options.allowInsecure,
        machine: { hostname: hostname(), platform: platform() },
      })

      managed.ws = agentWs

      agentWs.on('open', () => {
        this.logger.info('agent_ws_connected', { sessionId })
      })

      agentWs.on('handshake_ok', () => {
        managed.status = 'running'
        this.logger.info('agent_bridge_ready', { sessionId })
        // Set up relay with idle timeout
        const relay = new Relay(agent, agentWs, this.logger, {
          idleTimeoutSecs: managed.idleTimeoutSecs,
        })
        managed.relay = relay

        // Handle idle timeout: notify server and gracefully stop agent
        relay.on('idle', () => {
          this.handleIdleSuspend(managed)
        })

        // Stop buffering and hand the captured early messages to the relay so
        // they are flushed to the host before live relaying begins.
        detachEarlyBuffer()
        relay.start(earlyMessages.splice(0))
      })

      agentWs.on('handshake_error', (err) => {
        this.logger.error('agent_handshake_failed', { sessionId, code: err.code, message: err.message })
        detachEarlyBuffer()
        agent.terminate()
        this.agents.delete(sessionId)
      })

      agentWs.on('close', () => {
        managed.relay?.stop()
        managed.relay = null
        // Reconnection for agent bridge connections could be added here
      })

      agentWs.on('error', (err) => {
        this.logger.error('agent_ws_error', { sessionId, message: err.message })
      })

      agentWs.connect()

      // Return spawn result immediately (agent PID is already known)
      this.sendResponse(requestId, { sessionId, pid: managed.pid })
    } catch (err) {
      this.sendResponse(requestId, undefined, {
        code: -32000,
        message: `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  private async handleStop(requestId: string | number, params: StopParams): Promise<void> {
    if (!params?.sessionId) {
      this.sendResponse(requestId, undefined, { code: -32602, message: 'Missing required param: sessionId' })
      return
    }

    const managed = this.agents.get(params.sessionId)
    if (!managed) {
      this.sendResponse(requestId, undefined, { code: -32000, message: `Agent not found for session: ${params.sessionId}` })
      return
    }

    this.logger.info('stopping_agent', { sessionId: params.sessionId })
    managed.status = 'stopping'
    managed.relay?.stop()

    // Send goodbye on the agent's bridge WS
    if (managed.ws?.connected) {
      const goodbye: JsonRpcMessage = {
        jsonrpc: '2.0',
        method: AgentMethods.GOODBYE,
        params: { reason: 'daemon_stop_requested' },
      }
      managed.ws.send(goodbye)
    }

    // Gracefully stop the agent
    managed.agent.closeStdin()
    await this.waitForAgentExit(managed.agent, 5000)
    if (managed.agent.running) {
      managed.agent.terminate()
      await this.waitForAgentExit(managed.agent, 2000)
    }
    if (managed.agent.running) {
      managed.agent.kill()
    }

    managed.ws?.close()
    this.agents.delete(params.sessionId)

    this.sendResponse(requestId, { stopped: true })
  }

  private handleList(requestId: string | number): void {
    const agents = Array.from(this.agents.values()).map((m) => ({
      sessionId: m.sessionId,
      command: m.command,
      pid: m.pid,
      cwd: m.cwd,
      status: m.status === 'running' ? 'running' as const : 'starting' as const,
    }))
    this.sendResponse(requestId, { agents })
  }

  /**
   * Handle idle timeout for a managed agent.
   * Notifies the server via bridge/session_suspended, then gracefully stops the agent.
   * Does NOT send ACP session/close (that would invalidate the session for later resume).
   */
  private async handleIdleSuspend(managed: ManagedAgent): Promise<void> {
    if (managed.status !== 'running' || managed.idleSuspending) return

    managed.idleSuspending = true
    managed.status = 'suspending'
    const sessionId = managed.sessionId

    this.logger.info('idle_suspend_start', {
      sessionId,
      idleTimeoutSecs: managed.idleTimeoutSecs,
    })

    // Stop relay first to prevent new messages from flowing
    managed.relay?.stop()

    // Notify server that this session is being suspended
    if (managed.ws?.connected && sessionId) {
      const notification: JsonRpcMessage = {
        jsonrpc: '2.0',
        method: AgentMethods.SUSPENDED,
        params: {
          sessionId,
          reason: 'idle_timeout',
        },
      }
      managed.ws.send(notification)
    }

    // Gracefully stop the agent process (same sequence as handleStop)
    managed.agent.closeStdin()
    await this.waitForAgentExit(managed.agent, 5000)
    if (managed.agent.running) {
      managed.agent.terminate()
      await this.waitForAgentExit(managed.agent, 2000)
    }
    if (managed.agent.running) {
      managed.agent.kill()
    }

    // Send goodbye and close the agent's bridge WS
    if (managed.ws?.connected) {
      const goodbye: JsonRpcMessage = {
        jsonrpc: '2.0',
        method: AgentMethods.GOODBYE,
        params: { reason: 'idle_timeout' },
      }
      managed.ws.send(goodbye)
    }
    managed.ws?.close()
    this.agents.delete(managed.sessionId)

    this.logger.info('idle_suspend_complete', { sessionId })
  }

  private sendResponse(id: string | number, result?: unknown, error?: { code: number; message: string }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const msg: JsonRpcMessage = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result }
    this.ws.send(JSON.stringify(msg))
  }

  private startReconnection(): void {
    this.reconnectAttempt++
    const backoff = Math.min(
      Math.pow(2, this.reconnectAttempt - 1) * 1000,
      this.options.reconnectMax * 1000
    )
    this.logger.info('reconnecting', { attempt: this.reconnectAttempt, backoff_ms: backoff })
    this.reconnectTimer = setTimeout(() => this.connect(), backoff)
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.shutdownInProgress) return
    this.shutdownInProgress = true
    this.logger.info('daemon_shutting_down', { reason, agents: this.agents.size })

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // Stop all agents
    for (const [sessionId, managed] of this.agents) {
      this.logger.info('stopping_agent', { sessionId })
      managed.relay?.stop()
      managed.agent.closeStdin()
      await this.waitForAgentExit(managed.agent, 3000)
      if (managed.agent.running) managed.agent.terminate()
      await this.waitForAgentExit(managed.agent, 2000)
      if (managed.agent.running) managed.agent.kill()
      managed.ws?.close()
    }
    this.agents.clear()

    // Send goodbye and close daemon WS
    if (this.ws?.readyState === WebSocket.OPEN) {
      const goodbye: JsonRpcMessage = {
        jsonrpc: '2.0',
        method: AgentMethods.GOODBYE,
        params: { reason },
      }
      this.ws.send(JSON.stringify(goodbye))
      this.ws.close()
    }

    this.logger.info('daemon_stopped', { reason })
    process.exit(0)
  }

  private waitForAgentExit(agent: AgentProcess, ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (!agent.running) { resolve(); return }
      const timer = setTimeout(resolve, ms)
      agent.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }

  private setupSignalHandlers(): void {
    const handler = () => { this.shutdown('user_interrupt') }
    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)
  }
}
