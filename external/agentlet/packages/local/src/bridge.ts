import { randomUUID } from 'node:crypto'
import { hostname, platform } from 'node:os'
import { basename, resolve } from 'node:path'
import { BridgeMethods, type JsonRpcMessage } from '@agentlet/protocol'
import { AgentProcess } from './agent-process.js'
import { WsClient } from './ws-client.js'
import { Relay } from './relay.js'
import { Logger } from './logger.js'
import { bootstrapSession, type SessionProfile } from './session-bootstrap.js'
import type { CliOptions } from './cli.js'

export type BridgeState = 'starting' | 'connecting' | 'handshaking' | 'relaying' | 'reconnecting' | 'shutting_down' | 'stopped'

/**
 * Generate a unique agentId in the format: "<hostname>:<executable>:<cwd-basename>:<8-char-uuid>"
 * This is stable for the lifetime of this bridge process.
 */
function generateAgentId(command: string, cwd?: string): string {
  const host = hostname()
  const executable = basename(command.split(/\s+/)[0]!)
  const cwdBase = basename(cwd ?? process.cwd())
  const shortUuid = randomUUID().replace(/-/g, '').slice(0, 8)
  return `${host}:${executable}:${cwdBase}:${shortUuid}`
}

/**
 * Bridge is the lifecycle state machine that coordinates:
 * CLI options → Agent Process → WebSocket Client → Relay
 */
export class Bridge {
  private state: BridgeState = 'starting'
  private readonly options: CliOptions
  private readonly logger: Logger
  private readonly agentId: string
  private readonly cwd: string
  private agent!: AgentProcess
  private sessionProfile!: SessionProfile
  private ws!: WsClient
  private relay!: Relay
  private buffer: JsonRpcMessage[] = []
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shutdownInProgress = false

  constructor(options: CliOptions, logger: Logger) {
    this.options = options
    this.logger = logger
    this.cwd = resolve(options.cwd)
    this.agentId = generateAgentId(options.agent, this.cwd)
  }

  /** Start the bridge: spawn agent, bootstrap session, connect WebSocket, begin relay */
  async start(): Promise<void> {
    this.setupSignalHandlers()

    // 1. Spawn agent
    this.state = 'starting'
    this.agent = new AgentProcess({
      command: this.options.agent,
      cwd: this.cwd,
      env: this.options.env,
    })

    this.agent.on('exit', (code, signal) => {
      this.logger.info('agent_exited', { code, signal })
      this.sendBridgeNotification(BridgeMethods.AGENT_EXITED, {
        code, signal, willRestart: this.options.autoRestart && code !== 0,
      })

      if (this.shutdownInProgress) return

      if (this.options.autoRestart && code !== 0) {
        this.restartAgent()
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

    // 2. Session bootstrap (initialize + session/new)
    this.sessionProfile = await bootstrapSession(this.agent, { cwd: this.cwd }, this.logger)

    // 3. Now wire up the message handler for relay/buffering (after bootstrap is done)
    this.agent.on('message', (data) => {
      // If we're reconnecting, buffer messages
      if (this.state === 'reconnecting') {
        if (this.buffer.length < this.options.bufferLimit) {
          this.buffer.push(data as JsonRpcMessage)
        } else {
          this.logger.warn('buffer_overflow', { dropped: 1 })
        }
      }
    })

    // 4. Connect WebSocket
    this.connectWebSocket()
  }

  private connectWebSocket(): void {
    this.state = 'connecting'

    this.ws = new WsClient({
      serverUrl: this.options.server,
      token: this.options.token,
      agentCommand: this.options.agent,
      agentPid: this.agent.pid!,
      agentCwd: this.cwd,
      agentId: this.agentId,
      session: this.sessionProfile,
      capabilities: {
        autoRestart: this.options.autoRestart,
        bufferLimit: this.options.bufferLimit,
      },
      heartbeatInterval: this.options.heartbeat,
      allowInsecure: this.options.allowInsecure,
      machine: { hostname: hostname(), platform: platform() },
    })

    this.ws.on('open', () => {
      this.state = 'handshaking'
      this.logger.info('ws_connected', { server: this.options.server })
    })

    this.ws.on('handshake_ok', (result) => {
      this.state = 'relaying'
      this.reconnectAttempt = 0
      this.logger.info('handshake_ok', { agentId: result.agentId })

      // Flush any buffered messages from reconnection
      if (this.buffer.length > 0) {
        this.logger.info('buffer_flushing', { count: this.buffer.length })
        for (const msg of this.buffer) {
          this.ws.send(msg)
        }
        this.buffer = []
      }

      // Start relay
      this.relay = new Relay(this.agent, this.ws, this.logger)
      this.relay.start()
    })

    this.ws.on('handshake_error', (err) => {
      this.logger.error('handshake_failed', { code: err.code, message: err.message })
      this.shutdown('handshake_failed')
    })

    this.ws.on('close', (code, reason) => {
      if (this.shutdownInProgress) return

      this.logger.warn('ws_disconnected', { code, reason })
      this.relay?.stop()
      this.startReconnection()
    })

    this.ws.on('error', (err) => {
      this.logger.error('ws_error', { message: err.message })
    })

    this.ws.connect()
  }

  private startReconnection(): void {
    this.state = 'reconnecting'
    this.reconnectAttempt++

    const backoff = Math.min(
      Math.pow(2, this.reconnectAttempt - 1) * 1000,
      this.options.reconnectMax * 1000
    )

    this.logger.info('reconnecting', { attempt: this.reconnectAttempt, backoff_ms: backoff })

    this.reconnectTimer = setTimeout(() => {
      this.connectWebSocket()
    }, backoff)
  }

  private restartAgent(): void {
    // Restart logic — limited attempts
    const attempt = this.reconnectAttempt + 1
    if (attempt > this.options.restartMax) {
      this.logger.error('max_restarts_exceeded', { max: this.options.restartMax })
      this.sendBridgeNotification(BridgeMethods.GOODBYE, { reason: 'max_restarts_exceeded' })
      this.shutdown('max_restarts_exceeded')
      return
    }

    setTimeout(() => {
      this.agent.start()
      this.logger.info('agent_restarted', { pid: this.agent.pid, attempt })
      this.sendBridgeNotification(BridgeMethods.AGENT_RESTARTED, {
        pid: this.agent.pid!, attempt,
      })
    }, this.options.restartDelay)
  }

  private sendBridgeNotification(method: string, params: Record<string, unknown>): void {
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      method,
      params,
    }
    this.ws?.send(msg)
  }

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

    // Send goodbye
    this.sendBridgeNotification(BridgeMethods.GOODBYE, { reason })

    // Stop relay
    this.relay?.stop()

    // Shutdown agent: close stdin, wait, then force kill
    if (this.agent.running) {
      this.agent.closeStdin()

      await this.waitForExit(5000)

      if (this.agent.running) {
        this.agent.terminate()
        await this.waitForExit(2000)
      }

      if (this.agent.running) {
        this.agent.kill()
      }
    }

    // Close WebSocket
    this.ws?.close()

    this.state = 'stopped'
    this.logger.info('stopped', { reason })
  }

  private waitForExit(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.agent.running) {
        resolve()
        return
      }
      const timer = setTimeout(resolve, ms)
      this.agent.once('exit', () => {
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
