import { hostname, platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
  type SendResourceParams,
  type JsonRpcMessage,
} from '@agentlet/protocol'
import { AgentProcess } from './agent-process.js'
import { WsClient } from './ws-client.js'
import { Relay } from './relay.js'
import { Logger } from './logger.js'
import { bootstrapSession, type SessionProfile } from './session-bootstrap.js'
import type { AgentletOptions } from './cli.js'

type AgentletState = 'starting' | 'connecting' | 'handshaking' | 'relaying' | 'reconnecting' | 'shutting_down' | 'stopped'

interface ManagedAgent {
  sessionId: string
  command: string
  cwd: string
  pid: number
  agent: AgentProcess
  ws: WsClient
  relay: Relay | null
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'suspending'
  sessionProfile: SessionProfile
  idleTimeoutSecs: number
  /** Set to true when idle suspension is in progress — suppresses autoRestart */
  idleSuspending: boolean
}

/**
 * Agentlet is the unified lifecycle state machine for the agentlet CLI.
 *
 * Two modes, selected by the presence of `options.agent`:
 *
 * - **Bridge mode** (`--agent <cmd>`): Spawns a single local ACP agent,
 *   bootstraps an ACP session, and relays messages over a WebSocket to the
 *   server.
 *
 * - **Daemon mode** (no `--agent`): Connects a control channel to the server
 *   and waits for `server/spawn` commands, managing multiple agents on demand.
 */
export class Agentlet {
  private readonly options: AgentletOptions
  private readonly logger: Logger
  private readonly mode: 'bridge' | 'daemon'
  private state: AgentletState = 'starting'
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shutdownInProgress = false

  // Bridge mode state
  private agent!: AgentProcess
  private sessionProfile!: SessionProfile
  private sessionWs!: WsClient
  private relay!: Relay
  private buffer: JsonRpcMessage[] = []

  // Daemon mode state
  private readonly daemonId: string
  private controlWs: WebSocket | null = null
  private readonly agents = new Map<string, ManagedAgent>()
  private handshakeComplete = false

  /**
   * Unified env registry — all daemon-managed environment variables that
   * are injected into spawned agent processes. Initialized from defaults,
   * then overridden by process.env if present. Individual dirs are created
   * lazily when resources are received via server/sendResource.
   */
  private readonly envRegistry: Record<string, string> = {}

  constructor(options: AgentletOptions, logger: Logger) {
    this.options = options
    this.logger = logger
    this.mode = options.agent ? 'bridge' : 'daemon'
    this.daemonId = options.agentletId ?? hostname()

    // Well-known env vars with defaults — process.env overrides if set
    const defaults: Record<string, string> = {
      AGENTLET_SIDEBAND_DIR: join(tmpdir(), `agentlet-${this.daemonId}`, 'sideband'),
    }
    for (const [key, fallback] of Object.entries(defaults)) {
      this.envRegistry[key] = process.env[key] || fallback
    }
  }

  async start(): Promise<void> {
    this.setupSignalHandlers()
    if (this.mode === 'bridge') {
      await this.startBridge()
    } else {
      this.startDaemon()
    }
  }

  // ── Bridge mode ──────────────────────────────────────────────────────

  /** Start bridge: spawn agent, bootstrap session, connect WebSocket, begin relay */
  private async startBridge(): Promise<void> {
    const cwd = resolve(this.options.cwd)

    this.state = 'starting'
    this.agent = new AgentProcess({
      command: this.options.agent!,
      cwd,
      env: this.options.env,
    })

    this.agent.on('exit', (code, signal) => {
      this.logger.info('agent_exited', { code, signal })
      this.sendBridgeNotification(AgentMethods.EXITED, {
        code, signal, willRestart: this.options.autoRestart && code !== 0,
      })

      if (this.shutdownInProgress) return

      if (this.options.autoRestart && code !== 0) {
        this.restartBridgeAgent(cwd)
      } else {
        this.shutdown('agent_exited')
      }
    })

    this.agent.on('error', (err) => {
      this.logger.error('agent_error', { message: err.message })
    })

    this.agent.on('stderr', (line) => {
      this.logger.debug('agent_stderr', { line })
    })

    this.agent.start()
    this.logger.info('agent_spawned', { pid: this.agent.pid, command: this.options.agent })

    // Session bootstrap (initialize + session/new)
    this.sessionProfile = await bootstrapSession(this.agent, { cwd }, this.logger)

    // Wire up the message handler for relay/buffering (after bootstrap is done)
    this.agent.on('message', (data) => {
      if (this.state === 'reconnecting') {
        if (this.buffer.length < this.options.bufferLimit) {
          this.buffer.push(data as JsonRpcMessage)
        } else {
          this.logger.warn('buffer_overflow', { dropped: 1 })
        }
      }
    })

    this.connectBridgeWebSocket(cwd)
  }

  private connectBridgeWebSocket(cwd: string): void {
    this.state = 'connecting'

    this.sessionWs = new WsClient({
      serverUrl: this.options.server,
      token: this.options.token,
      sessionId: this.sessionProfile.sessionId,
      role: 'session',
      agentletId: hostname(),
      agent: {
        command: this.options.agent!,
        pid: this.agent.pid!,
        cwd,
      },
      session: this.sessionProfile,
      capabilities: {
        autoRestart: this.options.autoRestart,
        bufferLimit: this.options.bufferLimit,
      },
      heartbeatInterval: this.options.heartbeat,
      allowInsecure: this.options.allowInsecure,
      machine: { hostname: hostname(), platform: platform() },
    })

    this.sessionWs.on('open', () => {
      this.state = 'handshaking'
      this.logger.info('ws_connected', { server: this.options.server })
    })

    this.sessionWs.on('handshake_ok', (result) => {
      this.state = 'relaying'
      this.reconnectAttempt = 0
      this.logger.info('handshake_ok', { sessionId: result.sessionId })

      // Flush any buffered messages from reconnection
      if (this.buffer.length > 0) {
        this.logger.info('buffer_flushing', { count: this.buffer.length })
        for (const msg of this.buffer) {
          this.sessionWs.send(msg)
        }
        this.buffer = []
      }

      // Start relay
      this.relay = new Relay(this.agent, this.sessionWs, this.logger)
      this.relay.start()
    })

    this.sessionWs.on('handshake_error', (err) => {
      this.logger.error('handshake_failed', { code: err.code, message: err.message })
      this.shutdown('handshake_failed')
    })

    this.sessionWs.on('close', (code, reason) => {
      if (this.shutdownInProgress) return
      this.logger.warn('ws_disconnected', { code, reason })
      this.relay?.stop()
      this.startBridgeReconnection(cwd)
    })

    this.sessionWs.on('error', (err) => {
      this.logger.error('ws_error', { message: err.message })
    })

    this.sessionWs.connect()
  }

  private startBridgeReconnection(cwd: string): void {
    this.state = 'reconnecting'
    this.reconnectAttempt++

    const backoff = Math.min(
      Math.pow(2, this.reconnectAttempt - 1) * 1000,
      this.options.reconnectMax * 1000
    )

    this.logger.info('reconnecting', { attempt: this.reconnectAttempt, backoff_ms: backoff })

    this.reconnectTimer = setTimeout(() => {
      this.connectBridgeWebSocket(cwd)
    }, backoff)
  }

  private restartBridgeAgent(cwd: string): void {
    const attempt = this.reconnectAttempt + 1
    if (attempt > this.options.restartMax) {
      this.logger.error('max_restarts_exceeded', { max: this.options.restartMax })
      this.sendBridgeNotification(AgentMethods.GOODBYE, { reason: 'max_restarts_exceeded' })
      this.shutdown('max_restarts_exceeded')
      return
    }

    setTimeout(() => {
      this.agent.start()
      this.logger.info('agent_restarted', { pid: this.agent.pid, attempt })
      this.sendBridgeNotification(AgentMethods.RESTARTED, {
        pid: this.agent.pid!, attempt,
      })
    }, this.options.restartDelay)
  }

  private sendBridgeNotification(method: string, params: Record<string, unknown>): void {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', method, params }
    this.sessionWs?.send(msg)
  }

  // ── Resource handling ───────────────────────────────────────────────

  /**
   * Resolve `${ENV_VAR}` references in a destination path against
   * the daemon's envRegistry.
   */
  private resolveDestination(destination: string): string {
    return destination.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
      const value = this.envRegistry[varName]
      if (!value) {
        throw new Error(`Unknown env var in destination: ${varName}`)
      }
      return value
    })
  }

  /**
   * Handle server/sendResource — save a pushed file to the resolved
   * destination path (creating parent directories as needed).
   */
  private handleSendResource(params: SendResourceParams): void {
    try {
      const resolvedPath = this.resolveDestination(params.destination)
      const dir = resolve(resolvedPath, '..')
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolvedPath, params.content, 'utf8')
      this.logger.info('resource_saved', { destination: resolvedPath })
    } catch (err) {
      this.logger.warn('resource_save_failed', {
        destination: params.destination,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Daemon mode ──────────────────────────────────────────────────────

  private startDaemon(): void {
    this.logger.info('daemon_starting', { daemonId: this.daemonId })
    this.connectDaemonControl()
  }

  private connectDaemonControl(): void {
    if (!this.options.allowInsecure && !this.options.server.startsWith('wss://')) {
      this.logger.error('insecure_url', {
        message: `Server URL must use wss:// (got ${this.options.server}). Use --allow-insecure for local development.`,
      })
      process.exit(1)
    }

    this.handshakeComplete = false
    const url = new URL(this.options.server)
    if (this.options.token) {
      url.searchParams.set('token', this.options.token)
    }
    url.searchParams.set('role', 'agentlet')
    url.searchParams.set('id', this.daemonId)
    this.controlWs = new WebSocket(url.toString())

    this.controlWs.on('open', () => {
      this.logger.info('ws_connected', { server: this.options.server })
      this.sendDaemonHello()
    })

    this.controlWs.on('message', (data, isBinary) => {
      if (isBinary) {
        this.logger.error('binary_frame', { message: 'Received binary WebSocket frame' })
        return
      }
      const text = data.toString()
      try {
        const msg = JSON.parse(text) as JsonRpcMessage
        this.handleDaemonMessage(msg)
      } catch {
        this.logger.error('invalid_json', { text: text.slice(0, 200) })
      }
    })

    this.controlWs.on('close', (code, reason) => {
      if (this.shutdownInProgress) return
      this.logger.warn('ws_disconnected', { code, reason: reason.toString() })
      this.controlWs = null
      this.handshakeComplete = false
      this.startDaemonReconnection()
    })

    this.controlWs.on('error', (err) => {
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
    const hello: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: AgentletMethods.HELLO,
      id: 1,
      params: params as unknown as Record<string, unknown>,
    }
    this.controlWs?.send(JSON.stringify(hello))
  }

  private handleDaemonMessage(msg: JsonRpcMessage): void {
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
      this.handleDaemonRequest(msg as { jsonrpc: '2.0'; method: string; id: string | number; params?: Record<string, unknown> })
      return
    }

    // Handle notifications (e.g., server/shutdown, server/sendResource)
    if ('method' in msg && !('id' in msg)) {
      if (msg.method === ServerMethods.SHUTDOWN) {
        this.logger.info('shutdown_requested', { params: msg.params })
        this.shutdown('server_requested')
      } else if (msg.method === ServerMethods.SEND_RESOURCE) {
        this.handleSendResource(msg.params as unknown as SendResourceParams)
      }
    }
  }

  private handleDaemonRequest(msg: { jsonrpc: '2.0'; method: string; id: string | number; params?: Record<string, unknown> }): void {
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
        this.sendDaemonResponse(msg.id, undefined, { code: -32601, message: `Unknown method: ${msg.method}` })
    }
  }

  private async handleSpawn(requestId: string | number, params: SpawnParams): Promise<void> {
    const sessionSpec = params?.sessionSpec
    if (!sessionSpec?.command) {
      this.sendDaemonResponse(requestId, undefined, { code: -32602, message: 'Missing required param: sessionSpec.command' })
      return
    }

    if (this.options.maxAgents && this.agents.size >= this.options.maxAgents) {
      this.sendDaemonResponse(requestId, undefined, { code: -32000, message: `Max agents reached (${this.options.maxAgents})` })
      return
    }

    // Validate cwd: must be non-empty if provided, must exist on this machine
    let cwd: string
    if (sessionSpec.cwd && sessionSpec.cwd.trim()) {
      cwd = resolve(sessionSpec.cwd.trim())
      if (!existsSync(cwd)) {
        this.sendDaemonResponse(requestId, undefined, {
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
      // Inject daemon-managed env vars into the spawned agent process:
      // - AGENTLET_SERVER: WS URL for sideband HTTP derivation
      // - envRegistry: all well-known dirs (AGENTLET_SIDEBAND_DIR, etc.)
      // sessionSpec.env (from host app) is merged last to allow overrides.
      const agent = new AgentProcess({
        command: sessionSpec.command,
        cwd,
        env: {
          AGENTLET_SERVER: this.options.server,
          ...this.envRegistry,
          ...sessionSpec.env,
        },
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
      let bootstrap: SessionProfile
      try {
        bootstrap = await bootstrapSession(agent, {
          cwd,
          sessionId: params.sessionId,
        }, this.logger)
      } catch (err) {
        this.logger.error('session_bootstrap_failed', { message: err instanceof Error ? err.message : String(err) })
        agent.terminate()
        this.sendDaemonResponse(requestId, undefined, {
          code: -32000,
          message: `Session bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }

      const sessionId = bootstrap.sessionId

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
          // Clean up the agent's connection
          managed.relay?.stop()
          managed.ws?.close()
          this.agents.delete(sessionId)
        }
      })

      this.agents.set(sessionId, managed)

      // Open a new WS connection for this agent
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

        relay.start()
      })

      agentWs.on('handshake_error', (err) => {
        this.logger.error('agent_handshake_failed', { sessionId, code: err.code, message: err.message })
        agent.terminate()
        this.agents.delete(sessionId)
      })

      agentWs.on('close', () => {
        managed.relay?.stop()
        managed.relay = null
      })

      agentWs.on('error', (err) => {
        this.logger.error('agent_ws_error', { sessionId, message: err.message })
      })

      agentWs.connect()

      // Return spawn result immediately (agent PID is already known)
      this.sendDaemonResponse(requestId, { sessionId, pid: managed.pid })
    } catch (err) {
      this.sendDaemonResponse(requestId, undefined, {
        code: -32000,
        message: `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  private async handleStop(requestId: string | number, params: StopParams): Promise<void> {
    if (!params?.sessionId) {
      this.sendDaemonResponse(requestId, undefined, { code: -32602, message: 'Missing required param: sessionId' })
      return
    }

    const managed = this.agents.get(params.sessionId)
    if (!managed) {
      this.sendDaemonResponse(requestId, undefined, { code: -32000, message: `Agent not found for session: ${params.sessionId}` })
      return
    }

    this.logger.info('stopping_agent', { sessionId: params.sessionId })
    managed.status = 'stopping'
    managed.relay?.stop()

    // Send goodbye on the agent's WS
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

    this.sendDaemonResponse(requestId, { stopped: true })
  }

  private handleList(requestId: string | number): void {
    const agents = Array.from(this.agents.values()).map((m) => ({
      sessionId: m.sessionId,
      command: m.command,
      pid: m.pid,
      cwd: m.cwd,
      status: m.status === 'running' ? 'running' as const : 'starting' as const,
    }))
    this.sendDaemonResponse(requestId, { agents })
  }

  /**
   * Handle idle timeout for a managed agent.
   * Notifies the server via agent/suspended, then gracefully stops the agent.
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

    // Gracefully stop the agent process
    managed.agent.closeStdin()
    await this.waitForAgentExit(managed.agent, 5000)
    if (managed.agent.running) {
      managed.agent.terminate()
      await this.waitForAgentExit(managed.agent, 2000)
    }
    if (managed.agent.running) {
      managed.agent.kill()
    }

    // Send goodbye and close the agent's WS
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

  private sendDaemonResponse(id: string | number, result?: unknown, error?: { code: number; message: string }): void {
    if (!this.controlWs || this.controlWs.readyState !== WebSocket.OPEN) return

    const msg: JsonRpcMessage = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result }
    this.controlWs.send(JSON.stringify(msg))
  }

  private startDaemonReconnection(): void {
    this.reconnectAttempt++
    const backoff = Math.min(
      Math.pow(2, this.reconnectAttempt - 1) * 1000,
      this.options.reconnectMax * 1000
    )
    this.logger.info('reconnecting', { attempt: this.reconnectAttempt, backoff_ms: backoff })
    this.reconnectTimer = setTimeout(() => this.connectDaemonControl(), backoff)
  }

  // ── Shared ───────────────────────────────────────────────────────────

  private async shutdown(reason: string): Promise<void> {
    if (this.shutdownInProgress) return
    this.shutdownInProgress = true
    this.state = 'shutting_down'

    this.logger.info('shutting_down', { reason })

    // Clear reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.mode === 'bridge') {
      await this.shutdownBridge(reason)
    } else {
      await this.shutdownDaemon(reason)
    }

    this.state = 'stopped'
    this.logger.info('stopped', { reason })
  }

  private async shutdownBridge(reason: string): Promise<void> {
    // Send goodbye
    this.sendBridgeNotification(AgentMethods.GOODBYE, { reason })

    // Stop relay
    this.relay?.stop()

    // Shutdown agent: close stdin, wait, then force kill
    if (this.agent?.running) {
      this.agent.closeStdin()
      await this.waitForAgentExit(this.agent, 5000)

      if (this.agent.running) {
        this.agent.terminate()
        await this.waitForAgentExit(this.agent, 2000)
      }

      if (this.agent.running) {
        this.agent.kill()
      }
    }

    // Close WebSocket
    this.sessionWs?.close()
  }

  private async shutdownDaemon(reason: string): Promise<void> {
    // Stop all managed agents
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

    // Send goodbye and close daemon control WS
    if (this.controlWs?.readyState === WebSocket.OPEN) {
      const goodbye: JsonRpcMessage = {
        jsonrpc: '2.0',
        method: AgentMethods.GOODBYE,
        params: { reason },
      }
      this.controlWs.send(JSON.stringify(goodbye))
      this.controlWs.close()
    }

    process.exit(0)
  }

  private waitForAgentExit(agent: AgentProcess, ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (!agent.running) {
        resolve()
        return
      }
      const timer = setTimeout(resolve, ms)
      agent.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private setupSignalHandlers(): void {
    const handler = () => {
      this.shutdown('user_interrupt')
    }
    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)
  }
}
