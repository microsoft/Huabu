import { randomUUID } from 'node:crypto'
import { hostname, platform } from 'node:os'
import { basename, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import WebSocket from 'ws'
import {
  BridgeMethods,
  PROTOCOL_VERSION,
  type BridgeHelloParams,
  type BridgeHelloResult,
  type DaemonSpawnParams,
  type DaemonStopParams,
  type JsonRpcMessage,
} from '@agentlet/protocol'
import { AgentProcess } from './agent-process.js'
import { WsClient } from './ws-client.js'
import { Relay } from './relay.js'
import { Logger } from './logger.js'
import { bootstrapSession, type SessionProfile } from './session-bootstrap.js'
import type { DaemonOptions } from './cli.js'

interface ManagedAgent {
  agentId: string
  command: string
  cwd: string
  pid: number
  agent: AgentProcess
  ws: WsClient
  relay: Relay | null
  status: 'starting' | 'running' | 'stopping' | 'stopped'
}

function generateDaemonId(): string {
  const host = hostname()
  const shortUuid = randomUUID().replace(/-/g, '').slice(0, 8)
  return `${host}:daemon:agentlet:${shortUuid}`
}

function generateAgentId(command: string, cwd: string): string {
  const host = hostname()
  const executable = basename(command.split(/\s+/)[0]!)
  const cwdBase = basename(cwd)
  const shortUuid = randomUUID().replace(/-/g, '').slice(0, 8)
  return `${host}:${executable}:${cwdBase}:${shortUuid}`
}

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
    this.daemonId = generateDaemonId()
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
    this.ws = new WebSocket(this.options.server)

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
    const params: BridgeHelloParams = {
      token: this.options.token,
      agentId: this.daemonId,
      mode: 'daemon',
      bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
      machine: { hostname: hostname(), platform: platform() },
      capabilities: {
        autoRestart: true,
        bufferLimit: this.options.bufferLimit,
        maxAgents: this.options.maxAgents,
      },
    }
    const hello: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: BridgeMethods.HELLO,
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
        const result = msg.result as BridgeHelloResult
        this.handshakeComplete = true
        this.reconnectAttempt = 0
        this.logger.info('daemon_ready', { daemonId: result.agentId, agents: this.agents.size })
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
      if (msg.method === BridgeMethods.SHUTDOWN) {
        this.logger.info('shutdown_requested', { params: msg.params })
        this.shutdown('server_requested')
      }
    }
  }

  private handleRequest(msg: { jsonrpc: '2.0'; method: string; id: string | number; params?: Record<string, unknown> }): void {
    switch (msg.method) {
      case BridgeMethods.SPAWN:
        this.handleSpawn(msg.id, msg.params as unknown as DaemonSpawnParams)
        break
      case BridgeMethods.STOP:
        this.handleStop(msg.id, msg.params as unknown as DaemonStopParams)
        break
      case BridgeMethods.LIST:
        this.handleList(msg.id)
        break
      default:
        this.sendResponse(msg.id, undefined, { code: -32601, message: `Unknown method: ${msg.method}` })
    }
  }

  private async handleSpawn(requestId: string | number, params: DaemonSpawnParams): Promise<void> {
    if (!params?.command) {
      this.sendResponse(requestId, undefined, { code: -32602, message: 'Missing required param: command' })
      return
    }

    if (this.options.maxAgents && this.agents.size >= this.options.maxAgents) {
      this.sendResponse(requestId, undefined, { code: -32000, message: `Max agents reached (${this.options.maxAgents})` })
      return
    }

    // Validate cwd: must be non-empty if provided, must exist on this machine
    let cwd: string
    if (params.cwd && params.cwd.trim()) {
      cwd = resolve(params.cwd.trim())
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

    const agentId = generateAgentId(params.command, cwd)
    const autoRestart = params.autoRestart ?? false

    this.logger.info('spawning_agent', { agentId, command: params.command, cwd })

    try {
      // Spawn the agent process
      const agent = new AgentProcess({
        command: params.command,
        cwd,
        env: params.env,
      })

      const managed: ManagedAgent = {
        agentId,
        command: params.command,
        cwd,
        pid: 0,
        agent,
        ws: null!,
        relay: null,
        status: 'starting',
      }

      agent.on('error', (err) => {
        this.logger.error('agent_error', { agentId, message: err.message })
      })

      agent.on('stderr', (line) => {
        this.logger.debug('agent_stderr', { agentId, line })
      })

      agent.on('exit', (code, signal) => {
        this.logger.info('agent_exited', { agentId, code, signal })
        managed.status = 'stopped'

        // Notify the agent's own WS connection
        if (managed.ws?.connected) {
          const exitNotification: JsonRpcMessage = {
            jsonrpc: '2.0',
            method: BridgeMethods.AGENT_EXITED,
            params: { code, signal, willRestart: autoRestart && code !== 0 },
          }
          managed.ws.send(exitNotification)
        }

        if (autoRestart && code !== 0 && !this.shutdownInProgress) {
          this.logger.info('agent_restarting', { agentId })
          setTimeout(() => {
            if (this.agents.has(agentId) && !this.shutdownInProgress) {
              agent.start()
              managed.pid = agent.pid ?? 0
              managed.status = 'running'
              this.logger.info('agent_restarted', { agentId, pid: managed.pid })
            }
          }, 2000)
        } else {
          // Clean up the agent's bridge connection
          managed.relay?.stop()
          managed.ws?.close()
          this.agents.delete(agentId)
        }
      })

      agent.start()
      managed.pid = agent.pid ?? 0
      this.agents.set(agentId, managed)

      // Session bootstrap: initialize + session/new
      let sessionProfile: SessionProfile
      try {
        sessionProfile = await bootstrapSession(agent, { cwd }, this.logger)
      } catch (err) {
        this.logger.error('session_bootstrap_failed', { agentId, message: err instanceof Error ? err.message : String(err) })
        agent.terminate()
        this.agents.delete(agentId)
        this.sendResponse(requestId, undefined, {
          code: -32000,
          message: `Session bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }

      // Open a new bridge WS connection for this agent
      const agentWs = new WsClient({
        serverUrl: this.options.server,
        token: this.options.token,
        agentCommand: params.command,
        agentPid: managed.pid,
        agentCwd: cwd,
        agentId,
        session: sessionProfile,
        capabilities: { autoRestart, bufferLimit: this.options.bufferLimit },
        heartbeatInterval: this.options.heartbeat,
        allowInsecure: this.options.allowInsecure,
        machine: { hostname: hostname(), platform: platform() },
      })

      managed.ws = agentWs

      agentWs.on('open', () => {
        this.logger.info('agent_ws_connected', { agentId })
      })

      agentWs.on('handshake_ok', () => {
        managed.status = 'running'
        this.logger.info('agent_bridge_ready', { agentId })
        // Set up relay
        const relay = new Relay(agent, agentWs, this.logger)
        managed.relay = relay
        relay.start()
      })

      agentWs.on('handshake_error', (err) => {
        this.logger.error('agent_handshake_failed', { agentId, code: err.code, message: err.message })
        agent.terminate()
        this.agents.delete(agentId)
      })

      agentWs.on('close', () => {
        managed.relay?.stop()
        managed.relay = null
        // Reconnection for agent bridge connections could be added here
      })

      agentWs.on('error', (err) => {
        this.logger.error('agent_ws_error', { agentId, message: err.message })
      })

      agentWs.connect()

      // Return spawn result immediately (agent PID is already known)
      this.sendResponse(requestId, { agentId, pid: managed.pid })
    } catch (err) {
      this.sendResponse(requestId, undefined, {
        code: -32000,
        message: `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  private async handleStop(requestId: string | number, params: DaemonStopParams): Promise<void> {
    if (!params?.agentId) {
      this.sendResponse(requestId, undefined, { code: -32602, message: 'Missing required param: agentId' })
      return
    }

    const managed = this.agents.get(params.agentId)
    if (!managed) {
      this.sendResponse(requestId, undefined, { code: -32000, message: `Agent not found: ${params.agentId}` })
      return
    }

    this.logger.info('stopping_agent', { agentId: params.agentId })
    managed.status = 'stopping'
    managed.relay?.stop()

    // Send goodbye on the agent's bridge WS
    if (managed.ws?.connected) {
      const goodbye: JsonRpcMessage = {
        jsonrpc: '2.0',
        method: BridgeMethods.GOODBYE,
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
    this.agents.delete(params.agentId)

    this.sendResponse(requestId, { stopped: true })
  }

  private handleList(requestId: string | number): void {
    const agents = Array.from(this.agents.values()).map((m) => ({
      agentId: m.agentId,
      command: m.command,
      pid: m.pid,
      cwd: m.cwd,
      status: m.status === 'running' ? 'running' as const : 'starting' as const,
    }))
    this.sendResponse(requestId, { agents })
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
    for (const [agentId, managed] of this.agents) {
      this.logger.info('stopping_agent', { agentId })
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
        method: BridgeMethods.GOODBYE,
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
