import { fork, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { hostname, platform } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
  type AgentTeamScanParams,
  type AgentTeamSetupCancelParams,
  type AgentTeamSetupParams,
  type AgentTeamSetupProgressParams,
  type AgentTeamValidateParams,
  type JsonRpcMessage,
  type JsonRpcError,
} from '@agentlet/protocol'
import {
  resolveAgentTeam,
  scanAgentTeamRoot,
  validateManagedAgentTeam,
  type ManagedSetupWorkerMessage,
} from '@agentlet/agent-team'
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

interface ManagedSetupOperation {
  child: ChildProcess
  workingDirPath: string
  cancellationRequested: boolean
  terminalEventSent: boolean
}

/**
 * Upper bound on the early-message buffer (notifications collected between
 * bootstrap completing and the relay attaching). If the WS handshake stalls,
 * this prevents unbounded memory growth from streamed agent output.
 */
const EARLY_MESSAGE_BUFFER_CAP = 1000
const require = createRequire(import.meta.url)

export function resolveAgentletId(
  configuredId: string | undefined,
  machineHostname = hostname(),
): string {
  return configuredId?.trim() || machineHostname
}

export function resolveManagedSetupWorkerPath(
  moduleUrl = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
  resolvePackage: () => string = () => require.resolve('@agentlet/agent-team/setup-worker'),
): string {
  const bundledWorkerPath = join(dirname(fileURLToPath(moduleUrl)), 'setup-worker.js')
  return pathExists(bundledWorkerPath) ? bundledWorkerPath : resolvePackage()
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

  private readonly daemonId: string
  private controlWs: WebSocket | null = null
  private readonly agents = new Map<string, ManagedAgent>()
  private readonly setupOperations = new Map<string, ManagedSetupOperation>()
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
    this.daemonId = resolveAgentletId(options.agentletId)

    // Well-known env vars with defaults — process.env overrides if set.
    // Values are resolved to absolute paths against the daemon cwd so that
    // spawned agents (which run in a different cwd) reference the same dir.
    const defaults: Record<string, string> = {
      AGENTLET_REACHBACK_DIR: join('node_modules', '.cache', 'agentlet', 'reachback'),
    }
    for (const [key, fallback] of Object.entries(defaults)) {
      this.envRegistry[key] = resolve(process.env[key] || fallback)
    }
  }

  async start(): Promise<void> {
    this.setupSignalHandlers()
    this.startDaemon()
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
      machine: { hostname: this.daemonId, platform: platform() },
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
      case ServerMethods.AGENT_TEAM_SCAN:
        this.handleAgentTeamScan(msg.id, msg.params as unknown as AgentTeamScanParams)
        break
      case ServerMethods.AGENT_TEAM_SETUP:
        this.handleAgentTeamSetup(msg.id, msg.params as unknown as AgentTeamSetupParams)
        break
      case ServerMethods.AGENT_TEAM_SETUP_CANCEL:
        this.handleAgentTeamSetupCancel(msg.id, msg.params as unknown as AgentTeamSetupCancelParams)
        break
      case ServerMethods.AGENT_TEAM_VALIDATE:
        this.handleAgentTeamValidate(msg.id, msg.params as unknown as AgentTeamValidateParams)
        break
      default:
        this.sendDaemonResponse(msg.id, undefined, { code: -32601, message: `Unknown method: ${msg.method}` })
    }
  }

  private handleAgentTeamScan(requestId: string | number, params: AgentTeamScanParams): void {
    if (!params || typeof params.rootPath !== 'string' || params.rootPath.trim() === '') {
      this.sendDaemonResponse(requestId, undefined, {
        code: -32602,
        message: 'Missing required param: rootPath',
      })
      return
    }

    try {
      this.sendDaemonResponse(requestId, scanAgentTeamRoot(params.rootPath))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.sendDaemonResponse(requestId, undefined, {
        code: -32602,
        message,
        data: { code: 'agent_team_scan_failed' },
      })
    }
  }

  private handleAgentTeamSetup(requestId: string | number, params: AgentTeamSetupParams): void {
    const validationError = this.validateManagedOperationParams(params, true)
    if (validationError) {
      this.sendDaemonResponse(requestId, undefined, { code: -32602, message: validationError })
      return
    }
    if (this.setupOperations.has(params.operationId)) {
      this.sendDaemonResponse(requestId, undefined, {
        code: -32602,
        message: `Setup operation already exists: ${params.operationId}`,
        data: { code: 'setup_in_progress' },
      })
      return
    }
    const workingDirPath = resolve(params.workingDirPath)
    if (
      [...this.setupOperations.values()].some(
        (operation) => operation.workingDirPath === workingDirPath,
      )
    ) {
      this.sendDaemonResponse(requestId, undefined, {
        code: -32602,
        message: `A setup operation is already using workspace: ${workingDirPath}`,
        data: { code: 'workspace_setup_in_progress' },
      })
      return
    }

    try {
      const workerPath = resolveManagedSetupWorkerPath()
      const child = fork(
        workerPath,
        [
          JSON.stringify({
            packageDir: dirname(params.manifestPath),
            harness: params.harness,
            workingDirPath,
          }),
        ],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      )
      const operation: ManagedSetupOperation = {
        child,
        workingDirPath,
        cancellationRequested: false,
        terminalEventSent: false,
      }
      this.setupOperations.set(params.operationId, operation)
      child.stdout?.on('data', (data) => {
        this.logger.debug('agent_team_setup_stdout', {
          operationId: params.operationId,
          output: data.toString().trim(),
        })
      })
      child.stderr?.on('data', (data) => {
        this.logger.warn('agent_team_setup_stderr', {
          operationId: params.operationId,
          output: data.toString().trim(),
        })
      })
      child.on('message', (message: ManagedSetupWorkerMessage) => {
        this.handleManagedSetupWorkerMessage(params.operationId, operation, message)
      })
      child.once('error', (error) => {
        if (this.setupOperations.get(params.operationId) !== operation || operation.terminalEventSent) return
        this.setupOperations.delete(params.operationId)
        operation.terminalEventSent = true
        this.sendAgentTeamSetupProgress(
          operation.cancellationRequested
            ? { operationId: params.operationId, type: 'cancelled' }
            : {
                operationId: params.operationId,
                type: 'failed',
                error: { code: 'worker_exited', message: error.message },
              },
        )
      })
      child.once('exit', (code, signal) => {
        if (this.setupOperations.get(params.operationId) !== operation) return
        this.setupOperations.delete(params.operationId)
        if (operation.terminalEventSent) return
        operation.terminalEventSent = true
        if (operation.cancellationRequested) {
          this.sendAgentTeamSetupProgress({
            operationId: params.operationId,
            type: 'cancelled',
          })
        } else {
          this.sendAgentTeamSetupProgress({
            operationId: params.operationId,
            type: 'failed',
            error: {
              code: 'worker_exited',
              message: `Setup worker exited unexpectedly (${code === null ? `signal ${signal}` : `code ${code}`})`,
            },
          })
        }
      })
      this.sendDaemonResponse(requestId, {
        operationId: params.operationId,
        accepted: true,
      })
    } catch (error) {
      this.sendDaemonResponse(requestId, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
        data: { code: 'setup_start_failed' },
      })
    }
  }

  private handleAgentTeamSetupCancel(requestId: string | number, params: AgentTeamSetupCancelParams): void {
    if (!params || typeof params.operationId !== 'string' || params.operationId.trim() === '') {
      this.sendDaemonResponse(requestId, undefined, {
        code: -32602,
        message: 'Missing required param: operationId',
      })
      return
    }
    const operation = this.setupOperations.get(params.operationId)
    const cancelled = operation !== undefined && !operation.terminalEventSent
    if (cancelled) {
      operation.cancellationRequested = true
      operation.child.send({ type: 'cancel' })
      setTimeout(() => {
        if (this.setupOperations.get(params.operationId) === operation) {
          operation.child.kill('SIGTERM')
        }
      }, 500).unref()
    }
    this.sendDaemonResponse(requestId, {
      operationId: params.operationId,
      cancelled,
    })
  }

  private handleAgentTeamValidate(requestId: string | number, params: AgentTeamValidateParams): void {
    const validationError = this.validateManagedOperationParams(params, false)
    if (validationError) {
      this.sendDaemonResponse(requestId, undefined, { code: -32602, message: validationError })
      return
    }
    this.sendDaemonResponse(
      requestId,
      validateManagedAgentTeam({
        packageDir: dirname(params.manifestPath),
        harness: params.harness,
        workingDirPath: params.workingDirPath,
      }),
    )
  }

  private validateManagedOperationParams(
    params: AgentTeamSetupParams | AgentTeamValidateParams,
    requireOperationId: boolean,
  ): string | undefined {
    if (!params || typeof params !== 'object') return 'Missing Agent Team operation params'
    if (
      requireOperationId &&
      (!('operationId' in params) ||
        typeof params.operationId !== 'string' ||
        params.operationId.trim() === '')
    ) {
      return 'Missing required param: operationId'
    }
    if (typeof params.manifestPath !== 'string' || !isAbsolute(params.manifestPath)) {
      return 'manifestPath must be an absolute path'
    }
    if (typeof params.harness !== 'string' || params.harness.trim() === '') {
      return 'Missing required param: harness'
    }
    if (
      typeof params.workingDirPath !== 'string' ||
      !isAbsolute(params.workingDirPath)
    ) {
      return 'workingDirPath must be an absolute path'
    }
    return undefined
  }

  private handleManagedSetupWorkerMessage(
    operationId: string,
    operation: ManagedSetupOperation,
    message: ManagedSetupWorkerMessage,
  ): void {
    if (this.setupOperations.get(operationId) !== operation || operation.terminalEventSent) return
    if (operation.cancellationRequested) return
    if (message.type === 'progress') {
      this.sendAgentTeamSetupProgress({
        operationId,
        type: 'phase',
        ...message.progress,
      })
      return
    }

    operation.terminalEventSent = true
    this.setupOperations.delete(operationId)
    if (message.type === 'completed') {
      this.sendAgentTeamSetupProgress({
        operationId,
        type: 'completed',
        workingDirPath: message.workingDirPath,
      })
    } else {
      this.sendAgentTeamSetupProgress({
        operationId,
        type: 'failed',
        error: message.error,
      })
    }
  }

  private sendAgentTeamSetupProgress(params: AgentTeamSetupProgressParams): void {
    if (this.controlWs?.readyState !== WebSocket.OPEN) return
    this.controlWs.send(JSON.stringify({
      jsonrpc: '2.0',
      method: AgentletMethods.AGENT_TEAM_SETUP_PROGRESS,
      params,
    }))
  }

  private async handleSpawn(requestId: string | number, params: SpawnParams): Promise<void> {
    const sessionSpec = params?.sessionSpec

    // Agent Team resolution: translate { agentDir, harness } → { command, cwd, env }
    if (sessionSpec?.agentTeam) {
      try {
        const resolved = resolveAgentTeam(sessionSpec.agentTeam, sessionSpec.env)
        sessionSpec.command = resolved.command
        sessionSpec.cwd = resolved.cwd
        // resolveAgentTeam merges .env < host env, then prepends managed tool paths.
        sessionSpec.env = resolved.env
        this.logger.info('agent_team_resolved', {
          ...('manifestPath' in sessionSpec.agentTeam
            ? {
                manifestPath: sessionSpec.agentTeam.manifestPath,
                workingDirPath: sessionSpec.agentTeam.workingDirPath,
              }
            : { agentDir: sessionSpec.agentTeam.agentDir }),
          harness: sessionSpec.agentTeam.harness,
          command: resolved.command,
          cwd: resolved.cwd,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.sendDaemonResponse(requestId, undefined, { code: -32602, message: `Agent Team resolution failed: ${msg}` })
        return
      }
    }

    if (!sessionSpec?.command) {
      this.sendDaemonResponse(requestId, undefined, { code: -32602, message: 'Missing required param: sessionSpec.command (or sessionSpec.agentTeam)' })
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
      // - AGENTLET_SERVER: WS URL for reachback HTTP derivation
      // - AGENTLET_TOKEN: daemon token used to authenticate reachback
      // - envRegistry: all well-known dirs (AGENTLET_REACHBACK_DIR, etc.)
      // Host env overrides defaults, except for the daemon-owned token.
      const agent = new AgentProcess({
        command: sessionSpec.command,
        cwd,
        env: buildAgentProcessEnv(
          this.options.server,
          this.options.token,
          this.envRegistry,
          sessionSpec.env,
        ),
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
          ...(err instanceof SessionResumeUnavailableError
            ? { data: { code: err.code } }
            : {}),
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
        machine: { hostname: this.daemonId, platform: platform() },
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

  private sendDaemonResponse(id: string | number, result?: unknown, error?: JsonRpcError): void {
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

  private async shutdown(reason: string): Promise<void> {
    if (this.shutdownInProgress) return
    this.shutdownInProgress = true

    this.logger.info('shutting_down', { reason })

    // Clear reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    await this.shutdownDaemon(reason)
    this.logger.info('stopped', { reason })
  }

  private async shutdownDaemon(reason: string): Promise<void> {
    for (const operation of this.setupOperations.values()) {
      operation.cancellationRequested = true
      operation.child.send({ type: 'cancel' })
      operation.child.kill('SIGTERM')
    }
    this.setupOperations.clear()

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

export function buildAgentProcessEnv(
  server: string,
  token: string,
  envRegistry: Readonly<Record<string, string>>,
  sessionEnv?: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    AGENTLET_SERVER: server,
    ...envRegistry,
    ...sessionEnv,
    AGENTLET_TOKEN: token,
  }
}
