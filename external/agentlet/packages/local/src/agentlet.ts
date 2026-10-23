import { arch, hostname, platform } from 'node:os'
import { resolve } from 'node:path'
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
  type StopResult,
  type SendResourceParams,
  type JsonRpcMessage,
  type JsonRpcError,
} from '@agentlet/protocol'
import { discoverHarnesses, parseHarnessDiscoveryParams } from './harnesses/detect.js'
import { compileHarnessLaunch } from './harnesses/harness.js'
import { AgentProcess } from './agent-process.js'
import { WsClient } from './ws-client.js'
import { Relay } from './relay.js'
import { Logger } from './logger.js'
import {
  bootstrapSession,
  SessionResumeUnavailableError,
  type SessionProfile,
} from './session-bootstrap.js'
import type { AgentletOptions } from './cli.js'
import { resolveDeviceIdentity } from './device-identity.js'
import { monitorConnection } from './connection-health.js'
import {
  createBootstrapEnv,
  interpolateBootstrapDestination,
  mergeAgentEnvironment,
} from './bootstrap-env.js'

interface ManagedAgent {
  sessionId: string
  workloadType?: 'Job' | 'Deployment'
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
  transportLost: boolean
}

/**
 * Upper bound on the early-message buffer (notifications collected between
 * bootstrap completing and the relay attaching). If the WS handshake stalls,
 * this prevents unbounded memory growth from streamed agent output.
 */
const EARLY_MESSAGE_BUFFER_CAP = 1000

export function resolveAgentletId(
  configuredId: string | undefined,
  identityPath?: string,
): string {
  return configuredId?.trim() || resolveDeviceIdentity(identityPath)
}

/**
 * Agentlet connects a machine-level control channel and manages agent
 * processes requested by the host.
 */
export class Agentlet {
  private readonly options: AgentletOptions
  private readonly logger: Logger
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shutdownInProgress = false
  private serverRestartInProgress = false

  private readonly daemonId: string
  private readonly machine = {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
  }
  private controlWs: WebSocket | null = null
  private readonly agents = new Map<string, ManagedAgent>()
  private readonly startingAgents = new Set<AgentProcess>()
  private readonly startingCleanupTimers = new Map<AgentProcess, ReturnType<typeof setTimeout>>()
  private readonly stopOperations = new Map<string, Promise<StopResult>>()
  private handshakeComplete = false
  private controlHealth: ReturnType<typeof monitorConnection> | null = null

  private readonly bootstrapEnv: Readonly<Record<string, string>>

  constructor(options: AgentletOptions, logger: Logger) {
    this.bootstrapEnv = createBootstrapEnv(Object.entries(options.bootstrapEnv ?? {}))
    this.options = { ...options, bootstrapEnv: this.bootstrapEnv }
    this.logger = logger
    this.daemonId = resolveAgentletId(options.agentletId)
  }

  async start(): Promise<void> {
    this.setupSignalHandlers()
    this.startDaemon()
  }

  async stop(): Promise<void> {
    await this.shutdown('user_interrupt')
  }

  async forceStop(): Promise<void> {
    this.shutdownInProgress = true
    this.controlHealth?.stop()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    for (const timer of this.startingCleanupTimers.values()) clearTimeout(timer)
    for (const managed of this.agents.values()) {
      managed.status = 'stopping'
      managed.relay?.stop()
      managed.ws?.close()
    }
    const processes = new Set([
      ...this.startingAgents,
      ...[...this.agents.values()].map(managed => managed.agent),
    ])
    const results = await Promise.allSettled([...processes].map(async agent => {
      await agent.kill()
      await this.waitForAgentExit(agent, 2000)
      if (agent.running) throw new Error(`Agent process did not exit: ${agent.pid}`)
    }))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) {
      this.logger.error('forced_shutdown_cleanup_failed', {
        errors: failures.map(result => result.reason instanceof Error ? result.reason.message : String(result.reason)),
      })
    } else {
      this.logger.info('stopped', { reason: 'forced_shutdown' })
    }
    process.exit(1)
  }

  // ── Resource handling ───────────────────────────────────────────────

  /**
   * Resolve `${ENV_VAR}` references in a destination path against
   * the explicit bootstrap environment.
   */
  private resolveDestination(destination: string): string {
    return interpolateBootstrapDestination(destination, this.bootstrapEnv)
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
    const controlWs = new WebSocket(url.toString(), { handshakeTimeout: 10_000 })
    this.controlWs = controlWs
    this.controlHealth?.stop()
    this.controlHealth = monitorConnection(controlWs, this.options.heartbeat)

    this.controlWs.on('open', () => {
      this.logger.info('ws_connected', { server: this.options.server })
      this.sendDaemonHello()
    })

    this.controlWs.on('message', (data, isBinary) => {
      if (this.controlWs !== controlWs || this.shutdownInProgress) return
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
      if (this.shutdownInProgress || this.controlWs !== controlWs) return
      this.logger.warn('ws_disconnected', { code, reason: reason.toString() })
      this.controlWs = null
      this.handshakeComplete = false
      this.startDaemonReconnection()
    })

    this.controlWs.on('error', (err) => {
      this.logger.error('ws_error', { message: err.message })
    })

    this.controlWs.on('unexpected-response', (_request, response) => {
      response.resume()
      if (response.statusCode === 401 || response.statusCode === 403) {
        this.logger.error('authentication_failed', {
          statusCode: response.statusCode,
          message: 'Connection rejected. Copy a new connection command from Huabu and run it again.',
        })
        void this.shutdown('authentication_failed', 1)
      } else {
        this.logger.error('ws_upgrade_rejected', { statusCode: response.statusCode })
      }
      controlWs.terminate()
    })
  }

  private sendDaemonHello(): void {
    const agentletProfile: AgentletProfile = {
      bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
      machine: this.machine,
      capabilities: {
        autoRestart: true,
        bufferLimit: this.options.bufferLimit,
        maxAgents: this.options.maxAgents,
        harnessDiscovery: { version: 2 },
        harnessLaunch: { version: 2 },
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
        this.logger.error('handshake_failed', {
          code: msg.error.code,
          message: msg.error.message,
          action: 'Check the server connection settings. If credentials were rejected, copy a new connection command and run it again.',
        })
        this.shutdown('handshake_failed', 1)
        return
      }
      if ('result' in msg) {
        const result = msg.result as AgentHelloResult
        this.handshakeComplete = true
        this.controlHealth?.handshakeComplete()
        this.reconnectAttempt = 0
        this.logger.info('daemon_ready', { daemonId: result.sessionId, agentletId: this.daemonId, agents: this.agents.size })
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
        if (msg.params?.reason === 'server_shutting_down') {
          void this.reconnectAfterServerShutdown()
        } else {
          void this.shutdown('server_requested')
        }
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
      case ServerMethods.DISCOVER_HARNESSES:
        void this.handleDiscoverHarnesses(msg.id, msg.params)
        break
      default:
        this.sendDaemonResponse(msg.id, undefined, { code: -32601, message: `Unknown method: ${msg.method}` })
    }
  }

  private async handleDiscoverHarnesses(requestId: string | number, params: unknown): Promise<void> {
    let options
    try {
      options = parseHarnessDiscoveryParams(params)
    } catch (error) {
      this.sendDaemonResponse(requestId, undefined, {
        code: -32602,
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }
    try {
      this.sendDaemonResponse(requestId, await discoverHarnesses(options))
    } catch (error) {
      this.sendDaemonResponse(requestId, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async handleSpawn(requestId: string | number, params: SpawnParams): Promise<void> {
    if (this.shutdownInProgress || this.serverRestartInProgress) {
      this.sendDaemonResponse(requestId, undefined, {
        code: -32000,
        message: 'Agentlet is stopping or preparing to reconnect',
        data: { code: 'daemon_stopping' },
      })
      return
    }
    const sessionSpec = params?.sessionSpec

    if (!sessionSpec || typeof sessionSpec !== 'object' || Array.isArray(sessionSpec)) {
      this.sendDaemonResponse(requestId, undefined, { code: -32602, message: 'Missing required param: sessionSpec' })
      return
    }
    if (
      params.workloadType !== undefined &&
      params.workloadType !== 'Job' &&
      params.workloadType !== 'Deployment'
    ) {
      this.sendDaemonResponse(requestId, undefined, {
        code: -32602,
        message: 'Invalid workloadType',
      })
      return
    }

    if (sessionSpec && typeof sessionSpec === 'object' && 'agentTeam' in sessionSpec) {
      this.sendDaemonResponse(requestId, undefined, {
        code: -32602,
        message: 'sessionSpec.agentTeam is no longer supported; provide a generic command and cwd',
      })
      return
    }

    let command: string
    if (sessionSpec && 'launch' in sessionSpec) {
      try {
        if ('command' in sessionSpec) throw new Error('Provide exactly one of sessionSpec.command or sessionSpec.launch')
        if (Object.keys(sessionSpec).some((key) => !['launch', 'launchPlan', 'cwd', 'env', 'autoRestart', 'idleTimeoutSecs'].includes(key))) {
          throw new Error('Unknown structured sessionSpec field')
        }
        if ((sessionSpec.cwd !== undefined && typeof sessionSpec.cwd !== 'string') ||
          (sessionSpec.autoRestart !== undefined && typeof sessionSpec.autoRestart !== 'boolean') ||
          (sessionSpec.idleTimeoutSecs !== undefined &&
            (!Number.isFinite(sessionSpec.idleTimeoutSecs) || sessionSpec.idleTimeoutSecs < 0)) ||
          (sessionSpec.env !== undefined && (
            sessionSpec.env === null || typeof sessionSpec.env !== 'object' || Array.isArray(sessionSpec.env) ||
            Object.values(sessionSpec.env).some((value) => typeof value !== 'string')
          ))) {
          throw new Error('Invalid structured sessionSpec process options')
        }
        command = compileHarnessLaunch(sessionSpec.launch, sessionSpec.launchPlan).command
      } catch (error) {
        this.sendDaemonResponse(requestId, undefined, { code: -32602, message: error instanceof Error ? error.message : String(error) })
        return
      }
    } else if (sessionSpec && 'launchPlan' in sessionSpec) {
      this.sendDaemonResponse(requestId, undefined, { code: -32602, message: 'launchPlan requires sessionSpec.launch' })
      return
    } else if (typeof sessionSpec?.command !== 'string' || !sessionSpec.command.trim()) {
      this.sendDaemonResponse(requestId, undefined, { code: -32602, message: 'Missing required param: sessionSpec.command' })
      return
    } else {
      try {
        command = compileHarnessLaunch({ kind: 'acp-command', command: sessionSpec.command }).command
      } catch (error) {
        this.sendDaemonResponse(requestId, undefined, { code: -32602, message: error instanceof Error ? error.message : String(error) })
        return
      }
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
    let agentEnv: NodeJS.ProcessEnv
    try {
      agentEnv = buildAgentProcessEnv(
        this.options.server,
        this.options.token,
        this.bootstrapEnv,
        sessionSpec.env,
      )
    } catch (error) {
      this.sendDaemonResponse(requestId, undefined, {
        code: -32602,
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }

    if (
      this.options.maxAgents &&
      this.agents.size + this.startingAgents.size >= this.options.maxAgents
    ) {
      const active = {
        total: this.agents.size + this.startingAgents.size,
        jobs: 0,
        deployments: 0,
        unknown: this.startingAgents.size,
        stopping: 0,
      }
      for (const managed of this.agents.values()) {
        if (managed.workloadType === 'Job') active.jobs++
        else if (managed.workloadType === 'Deployment') active.deployments++
        else active.unknown++
        if (managed.status === 'stopping') active.stopping++
      }
      this.sendDaemonResponse(requestId, undefined, {
        code: -32000,
        message: `Max agents reached (${this.options.maxAgents})`,
        data: {
          code: 'capacity_exhausted',
          limit: this.options.maxAgents,
          active,
        },
      })
      return
    }
    this.logger.info('spawning_agent', { command, cwd, sessionId: params.sessionId })

    const spawnSocket = this.controlWs
    const agent = new AgentProcess({
      command,
      cwd,
      env: agentEnv,
      inheritEnv: false,
    })
    this.startingAgents.add(agent)
    try {
      agent.on('error', (err) => {
        this.logger.error('agent_error', { command, message: err.message })
      })

      agent.on('stderr', (line) => {
        this.logger.debug('agent_stderr', { command, line })
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
        if (this.controlWs === spawnSocket) this.sendDaemonResponse(requestId, undefined, {
          code: -32000,
          message: `Session bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
          ...(err instanceof SessionResumeUnavailableError
            ? { data: { code: err.code } }
            : {}),
        })
        return
      }
      if (this.controlWs !== spawnSocket || this.shutdownInProgress || this.serverRestartInProgress) {
        this.logger.warn('spawn_cancelled', { message: 'Server disconnected during agent bootstrap.' })
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
        ...(params.workloadType ? { workloadType: params.workloadType } : {}),
        command,
        cwd,
        pid,
        agent,
        ws: null!,
        relay: null,
        status: 'starting',
        sessionProfile: bootstrap,
        idleTimeoutSecs: sessionSpec.idleTimeoutSecs ?? 0,
        idleSuspending: false,
        transportLost: false,
      }

      agent.on('exit', async (code, signal) => {
        this.logger.info('agent_exited', { sessionId, code, signal })
        const wasStopping = managed.status === 'stopping'
        managed.status = 'stopping'
        // Drop the early-message buffer listener if the agent exits before
        // handshake_ok (idempotent if already detached).
        detachEarlyBuffer()

        // Notify the agent's own WS connection
        if (managed.ws?.connected) {
          const exitNotification: JsonRpcMessage = {
            jsonrpc: '2.0',
            method: AgentMethods.EXITED,
            params: {
              code,
              signal,
              willRestart:
                autoRestart &&
                code !== 0 &&
                !managed.idleSuspending &&
                !wasStopping,
            },
          }
          managed.ws.send(exitNotification)
        }

        if (wasStopping || managed.idleSuspending || this.shutdownInProgress) return
        try {
          await this.stopAgentProcess(agent)
        } catch (error) {
          this.logger.error('agent_exit_cleanup_failed', {
            sessionId,
            message: error instanceof Error ? error.message : String(error),
          })
          return
        }
        managed.status = 'stopped'

        // Suppress autoRestart if this exit was caused by idle suspension
        if (
          autoRestart &&
          code !== 0 &&
          !this.shutdownInProgress &&
          !managed.transportLost &&
          !managed.idleSuspending &&
          !wasStopping
        ) {
          this.logger.info('agent_restarting', { sessionId })
          setTimeout(() => {
            if (this.agents.has(sessionId) && !this.shutdownInProgress) {
              if (this.serverRestartInProgress || managed.status === 'stopping' ||
                managed.transportLost || !managed.ws.connected || !managed.relay) return
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
      this.startingAgents.delete(agent)

      // Open a new WS connection for this agent
      const agentWs = new WsClient({
        serverUrl: this.options.server,
        token: this.options.token,
        sessionId,
        role: 'session',
        agentletId: this.daemonId,
        agent: {
          command,
          pid: managed.pid,
          cwd,
        },
        session: bootstrap,
        capabilities: { autoRestart, bufferLimit: this.options.bufferLimit },
        heartbeatInterval: this.options.heartbeat,
        allowInsecure: this.options.allowInsecure,
        machine: this.machine,
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
          void this.handleIdleSuspend(managed).catch((error: unknown) => {
            managed.status = 'stopping'
            this.logger.error('idle_suspend_failed', {
              sessionId,
              message: error instanceof Error ? error.message : String(error),
            })
          })
        })

        // Stop buffering and hand the captured early messages to the relay so
        // they are flushed to the host before live relaying begins.
        detachEarlyBuffer()
        relay.start(earlyMessages.splice(0))
      })

      agentWs.on('handshake_error', (err) => {
        this.logger.error('agent_handshake_failed', { sessionId, code: err.code, message: err.message })
        detachEarlyBuffer()
        void this.stopManagedAgent(managed).catch((error: unknown) => {
          this.logger.error('agent_cleanup_failed', {
            sessionId,
            message: error instanceof Error ? error.message : String(error),
          })
        })
      })

      agentWs.on('close', () => {
        managed.transportLost = true
        detachEarlyBuffer()
        managed.relay?.stop()
        managed.relay = null
        if (this.shutdownInProgress || this.serverRestartInProgress ||
          managed.status === 'stopping' || managed.idleSuspending) return
        this.logger.warn('agent_connection_lost', {
          sessionId,
          message: 'The session disconnected. Stopping the agent without replaying requests; a later user turn can recover the session.',
        })
        void this.stopManagedAgent(managed).catch((error: unknown) => {
          this.logger.error('agent_cleanup_failed', {
            sessionId,
            message: error instanceof Error ? error.message : String(error),
          })
        })
      })

      agentWs.on('error', (err) => {
        this.logger.error('agent_ws_error', { sessionId, message: err.message })
      })

      agentWs.connect()

      // Return spawn result immediately (agent PID is already known)
      this.sendDaemonResponse(requestId, { sessionId, pid: managed.pid })
    } catch (err) {
      this.logger.error('spawn_failed', {
        message: err instanceof Error ? err.message : String(err),
      })
      if (this.controlWs === spawnSocket) this.sendDaemonResponse(requestId, undefined, {
        code: -32000,
        message: `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      if (this.startingAgents.has(agent)) {
        try {
          await this.stopStartingAgent(agent)
        } catch (error) {
          this.logger.error('starting_agent_cleanup_failed', {
            pid: agent.pid,
            message: error instanceof Error ? error.message : String(error),
          })
          this.scheduleStartingAgentCleanup(agent)
        }
      }
    }
  }

  private async stopStartingAgent(agent: AgentProcess): Promise<void> {
    const timer = this.startingCleanupTimers.get(agent)
    if (timer) clearTimeout(timer)
    this.startingCleanupTimers.delete(agent)
    await this.stopAgentProcess(agent)
    this.startingAgents.delete(agent)
  }

  private scheduleStartingAgentCleanup(agent: AgentProcess): void {
    if (this.shutdownInProgress || this.serverRestartInProgress ||
      !this.startingAgents.has(agent) || this.startingCleanupTimers.has(agent)) return
    this.startingCleanupTimers.set(agent, setTimeout(() => {
      void this.stopStartingAgent(agent).catch((error: unknown) => {
        this.logger.error('starting_agent_cleanup_failed', {
          pid: agent.pid,
          message: error instanceof Error ? error.message : String(error),
        })
        this.scheduleStartingAgentCleanup(agent)
      })
    }, 1000))
  }

  private async handleStop(requestId: string | number, params: StopParams): Promise<void> {
    if (!params?.sessionId) {
      this.sendDaemonResponse(requestId, undefined, { code: -32602, message: 'Missing required param: sessionId' })
      return
    }

    const inFlight = this.stopOperations.get(params.sessionId)
    if (inFlight) {
      try {
        this.sendDaemonResponse(requestId, await inFlight)
      } catch (error) {
        this.sendStopFailure(requestId, error)
      }
      return
    }

    const managed = this.agents.get(params.sessionId)
    if (!managed) {
      this.sendDaemonResponse(requestId, {
        stopped: true,
        disposition: 'already_absent',
      } satisfies StopResult)
      return
    }

    try {
      this.sendDaemonResponse(requestId, await this.stopManagedAgent(managed))
    } catch (error) {
      this.sendStopFailure(requestId, error)
    }
  }

  private stopManagedAgent(managed: ManagedAgent): Promise<StopResult> {
    const existing = this.stopOperations.get(managed.sessionId)
    if (existing) return existing
    const operation = this.performStopManagedAgent(managed).finally(() => {
      if (this.stopOperations.get(managed.sessionId) === operation) {
        this.stopOperations.delete(managed.sessionId)
      }
    })
    this.stopOperations.set(managed.sessionId, operation)
    return operation
  }

  private async performStopManagedAgent(managed: ManagedAgent): Promise<StopResult> {
    this.logger.info('stopping_agent', { sessionId: managed.sessionId })
    managed.status = 'stopping'
    managed.relay?.stop()

    if (managed.ws?.connected) {
      const goodbye: JsonRpcMessage = {
        jsonrpc: '2.0',
        method: AgentMethods.GOODBYE,
        params: { reason: 'daemon_stop_requested' },
      }
      managed.ws.send(goodbye)
    }

    await this.stopAgentProcess(managed.agent)

    managed.ws?.close()
    this.agents.delete(managed.sessionId)
    return { stopped: true, disposition: 'stopped' }
  }

  private sendStopFailure(requestId: string | number, error: unknown): void {
    this.sendDaemonResponse(requestId, undefined, {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
      data: { code: 'agent_stop_failed', stillRunning: true },
    })
  }

  private handleList(requestId: string | number): void {
    const agents = Array.from(this.agents.values()).map((m) => ({
      sessionId: m.sessionId,
      command: m.command,
      pid: m.pid,
      cwd: m.cwd,
      ...(m.workloadType ? { workloadType: m.workloadType } : {}),
      status: m.status === 'running'
        ? 'running' as const
        : m.status === 'stopping'
          ? 'stopping' as const
          : 'starting' as const,
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
    await this.stopAgentProcess(managed.agent)

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

  private sendDaemonResponse(id: string | number, result?: unknown, error?: JsonRpcError): void {
    if (!this.controlWs || this.controlWs.readyState !== WebSocket.OPEN) return

    const msg: JsonRpcMessage = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result }
    this.controlWs.send(JSON.stringify(msg))
  }

  private startDaemonReconnection(): void {
    if (this.shutdownInProgress || this.serverRestartInProgress || this.reconnectTimer) return
    this.reconnectAttempt++
    const backoff = Math.min(
      Math.pow(2, this.reconnectAttempt - 1) * 1000,
      this.options.reconnectMax * 1000
    )
    this.logger.info('reconnecting', { attempt: this.reconnectAttempt, backoff_ms: backoff })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.shutdownInProgress) this.connectDaemonControl()
    }, backoff)
  }

  private async reconnectAfterServerShutdown(): Promise<void> {
    if (this.shutdownInProgress || this.serverRestartInProgress) return
    this.serverRestartInProgress = true
    this.logger.info('server_restarting', { message: 'Waiting for the server to return; this device will reconnect automatically.' })
    const controlWs = this.controlWs
    this.controlWs = null
    this.handshakeComplete = false
    controlWs?.close()
    try {
      const results = await Promise.allSettled([
        ...[...this.agents.values()].map(managed =>
          this.stopOperations.get(managed.sessionId) ?? this.stopManagedAgent(managed),
        ),
        ...[...this.startingAgents].map(agent => this.stopStartingAgent(agent)),
      ])
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length) throw new AggregateError(
        failures.map(result => result.reason), 'Restart process-tree cleanup failed',
      )
    } catch (error) {
      this.logger.error('restart_cleanup_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      await this.shutdown('restart_cleanup_failed', 1)
      return
    } finally {
      this.serverRestartInProgress = false
    }
    this.startDaemonReconnection()
  }

  private async stopAgentProcess(agent: AgentProcess, gracefulTimeout = 5000): Promise<void> {
    agent.closeStdin()
    await this.waitForAgentExit(agent, gracefulTimeout)
    if (agent.running) {
      await agent.terminate()
      await this.waitForAgentExit(agent, 2000)
    }
    if (agent.running) {
      await agent.kill()
      await this.waitForAgentExit(agent, 2000)
    }
    if (agent.running) {
      throw new Error(`Agent process did not exit: ${agent.pid}`)
    }
  }

  private async shutdown(reason: string, exitCode = 0): Promise<void> {
    if (this.shutdownInProgress) return
    this.shutdownInProgress = true
    this.controlHealth?.stop()
    for (const timer of this.startingCleanupTimers.values()) clearTimeout(timer)
    this.startingCleanupTimers.clear()

    this.logger.info('shutting_down', { reason })

    // Clear reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    try {
      await this.shutdownDaemon(reason)
    } catch (error) {
      this.logger.error('shutdown_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      process.exit(1)
      return
    }
    this.logger.info('stopped', { reason })
    process.exit(exitCode)
  }

  private async shutdownDaemon(reason: string): Promise<void> {
    const results = await Promise.allSettled([
      ...[...this.startingAgents].map(agent => this.stopStartingAgent(agent)),
      ...[...this.agents.values()].map(async managed => {
        const stopping = this.stopOperations.get(managed.sessionId)
        if (stopping) {
          await stopping
          return
        }
        this.logger.info('stopping_agent', { sessionId: managed.sessionId })
        managed.status = 'stopping'
        try {
          managed.relay?.stop()
          await this.stopAgentProcess(managed.agent, 3000)
          this.agents.delete(managed.sessionId)
        } finally {
          managed.ws?.close()
        }
      }),
    ])

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

    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) {
      this.logger.error('shutdown_cleanup_failed', {
        errors: failures.map(result =>
          result.reason instanceof Error ? result.reason.message : String(result.reason)),
      })
      throw new AggregateError(
        failures.map(result => result.reason), 'Shutdown process-tree cleanup failed',
      )
    }
  }

  private async waitForAgentExit(agent: AgentProcess, ms: number): Promise<void> {
    const deadline = Date.now() + ms
    while (agent.running && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  private setupSignalHandlers(): void {
    const handler = () => {
      this.shutdown('user_interrupt')
    }
    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)
  }
}

export function buildAgentProcessEnv(
  server: string,
  token: string,
  bootstrapEnv: Readonly<Record<string, string>>,
  sessionEnv: Readonly<Record<string, string>> = {},
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return mergeAgentEnvironment(
    { ...inherited, AGENTLET_SERVER: server },
    sessionEnv,
    createBootstrapEnv(Object.entries(bootstrapEnv), platform),
    {
      AGENTLET_TOKEN: token,
    },
    platform,
  )
}
