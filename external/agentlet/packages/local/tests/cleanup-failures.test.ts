import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agentlet } from '../src/agentlet.js'
import { AgentProcess } from '../src/agent-process.js'
import { Logger } from '../src/logger.js'
import { Relay } from '../src/relay.js'
import { WsClient } from '../src/ws-client.js'

const agents: AgentProcess[] = []
const relays: Relay[] = []
const sessionSockets: WsClient[] = []
let live: WeakMap<AgentProcess, boolean>
let bootstrapFailure = false

async function invoke(daemon: Agentlet, name: string, ...args: unknown[]): Promise<unknown> {
  const method: unknown = Reflect.get(daemon, name)
  if (typeof method !== 'function') throw new Error(`Missing daemon method: ${name}`)
  return Reflect.apply(method, daemon, args)
}

function tracked(daemon: Agentlet, name: 'agents' | 'startingAgents'): Map<unknown, unknown> | Set<unknown> {
  const value: unknown = Reflect.get(daemon, name)
  if (!(value instanceof Map) && !(value instanceof Set)) throw new Error(`Missing tracking collection: ${name}`)
  return value
}

function fixture() {
  const logger = new Logger('error')
  vi.spyOn(logger, 'error').mockImplementation(() => undefined)
  const daemon = new Agentlet({
    server: 'ws://127.0.0.1:1', token: 'test-token', agentletId: 'cleanup-test',
    allowInsecure: true, reconnectMax: 1, bufferLimit: 10, heartbeat: 0,
    logLevel: 'error', maxAgents: 2,
  }, logger)
  const responses = vi.fn()
  Reflect.set(daemon, 'sendDaemonResponse', responses)
  return { daemon, logger, responses }
}

async function spawn(daemon: Agentlet, id: number, autoRestart = false): Promise<void> {
  const operation = invoke(daemon, 'handleSpawn', id, {
    appId: `app-${id}`, sessionSpec: { command: 'test-agent-not-executed', autoRestart },
  })
  await vi.advanceTimersByTimeAsync(300)
  await operation
}

beforeEach(() => {
  agents.length = 0
  relays.length = 0
  sessionSockets.length = 0
  live = new WeakMap()
  bootstrapFailure = false
  vi.useFakeTimers()
  vi.spyOn(AgentProcess.prototype, 'start').mockImplementation(function (this: AgentProcess) {
    agents.push(this)
    live.set(this, true)
  })
  vi.spyOn(AgentProcess.prototype, 'running', 'get').mockImplementation(function (this: AgentProcess) {
    return live.get(this) ?? false
  })
  vi.spyOn(AgentProcess.prototype, 'write').mockImplementation(function (this: AgentProcess, message: unknown) {
    if (!message || typeof message !== 'object' || !('id' in message) || !('method' in message)) {
      throw new Error('Invalid bootstrap fixture request')
    }
    queueMicrotask(() => this.emit('message', {
      jsonrpc: '2.0', id: message.id,
      ...(bootstrapFailure
        ? { error: { code: -32000, message: 'Injected bootstrap failure' } }
        : { result: message.method === 'initialize'
          ? { protocolVersion: 1, agentCapabilities: {} }
          : { sessionId: `session-${agents.indexOf(this)}` } }),
    }))
    return true
  })
  vi.spyOn(WsClient.prototype, 'connect').mockImplementation(function (this: WsClient) {
    sessionSockets.push(this)
    this.emit('handshake_ok', { sessionId: 'test-session' })
  })
  vi.spyOn(Relay.prototype, 'start').mockImplementation(function (this: Relay) {
    relays.push(this)
  })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('cleanup failure ownership', () => {
  it.each(['during cleanup', 'during restart delay'])(
    'does not restart after session transport loss %s',
    async phase => {
      const { daemon } = fixture()
      let finish = () => {}
      Reflect.set(daemon, 'stopAgentProcess', vi.fn(() => new Promise<void>(resolve => {
        finish = resolve
      })))
      await spawn(daemon, 1, true)
      agents[0].emit('exit', 1, null)
      if (phase === 'during restart delay') {
        finish()
        await vi.advanceTimersByTimeAsync(0)
      }
      sessionSockets[0].emit('close')
      finish()
      await vi.advanceTimersByTimeAsync(3000)
      expect(agents).toHaveLength(1)
      expect(tracked(daemon, 'agents').size).toBe(0)
    },
  )

  it('forcefully cleans both pending and managed processes while cooperative shutdown is stalled', async () => {
    const { daemon } = fixture()
    await spawn(daemon, 1)
    const pending = new AgentProcess({ command: 'pending-agent-not-executed' })
    pending.start()
    const starting = tracked(daemon, 'startingAgents')
    if (!(starting instanceof Set)) throw new Error('Expected pending launch set')
    starting.add(pending)
    Reflect.set(daemon, 'shutdownInProgress', true)
    const kill = vi.spyOn(AgentProcess.prototype, 'kill').mockImplementation(async function (this: AgentProcess) {
      live.set(this, false)
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    await daemon.forceStop()
    expect(kill).toHaveBeenCalledTimes(2)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('does not confirm cleanup if forced process-tree termination fails', async () => {
    const entries = vi.fn()
    const daemon = new Agentlet({
      server: 'ws://127.0.0.1:1', token: 'test-token', agentletId: 'cleanup-test',
      allowInsecure: true, reconnectMax: 1, bufferLimit: 10, heartbeat: 0,
      logLevel: 'error', maxAgents: 2,
    }, new Logger('error', undefined, entries))
    await spawn(daemon, 1)
    vi.spyOn(AgentProcess.prototype, 'kill').mockRejectedValue(new Error('Injected kill failure'))
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    await daemon.forceStop()
    expect(entries).toHaveBeenCalledWith(expect.objectContaining({ event: 'forced_shutdown_cleanup_failed' }))
    expect(entries).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'stopped' }))
    expect(exit).toHaveBeenCalledWith(1)
  })

  it.each(['shutdownInProgress', 'serverRestartInProgress'])(
    'rejects new launches while %s is active',
    async flag => {
      const { daemon, responses } = fixture()
      Reflect.set(daemon, flag, true)
      await spawn(daemon, 1)
      expect(agents).toHaveLength(0)
      expect(tracked(daemon, 'startingAgents').size).toBe(0)
      expect(responses).toHaveBeenLastCalledWith(1, undefined, expect.objectContaining({
        data: { code: 'daemon_stopping' },
      }))
    },
  )

  it('reserves failed bootstrap capacity until a successful cleanup retry', async () => {
    const { daemon, logger, responses } = fixture()
    bootstrapFailure = true
    const stop = vi.fn(async (agent: AgentProcess) => { live.set(agent, false) })
      .mockRejectedValueOnce(new Error('Injected cleanup failure'))
      .mockRejectedValueOnce(new Error('Repeated cleanup failure'))
      .mockRejectedValueOnce(new Error('Retry cleanup failure'))
    Reflect.set(daemon, 'stopAgentProcess', stop)
    await spawn(daemon, 1)
    await spawn(daemon, 2)
    expect(tracked(daemon, 'startingAgents').size).toBe(2)
    expect(tracked(daemon, 'agents').size).toBe(0)
    await spawn(daemon, 3)
    expect(responses).toHaveBeenLastCalledWith(3, undefined, expect.objectContaining({
      data: expect.objectContaining({ code: 'capacity_exhausted', active: expect.objectContaining({ total: 2 }) }),
    }))
    expect(agents).toHaveLength(2)
    expect(logger.error).toHaveBeenCalledWith('starting_agent_cleanup_failed', expect.any(Object))
    await vi.advanceTimersByTimeAsync(1000)
    expect(tracked(daemon, 'startingAgents').size).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(tracked(daemon, 'startingAgents').size).toBe(0)
    bootstrapFailure = false
    await spawn(daemon, 4)
    expect(responses).toHaveBeenLastCalledWith(4, expect.objectContaining({ sessionId: 'session-2' }))
    expect(tracked(daemon, 'agents').size).toBe(1)
  })

  it('retains a cancelled launch until its failed cleanup can be retried', async () => {
    const { daemon } = fixture()
    const stop = vi.fn(async (agent: AgentProcess) => { live.set(agent, false) })
      .mockRejectedValueOnce(new Error('Cancelled launch cleanup failure'))
    Reflect.set(daemon, 'stopAgentProcess', stop)
    const operation = invoke(daemon, 'handleSpawn', 1, {
      appId: 'cancelled', sessionSpec: { command: 'test-agent-not-executed' },
    })
    Reflect.set(daemon, 'controlWs', null)
    Reflect.set(daemon, 'serverRestartInProgress', true)
    await vi.advanceTimersByTimeAsync(300)
    await operation
    expect(tracked(daemon, 'startingAgents').size).toBe(1)
    expect(tracked(daemon, 'agents').size).toBe(0)
    Reflect.set(daemon, 'serverRestartInProgress', false)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    await invoke(daemon, 'shutdown', 'cancelled-start')
    expect(stop).toHaveBeenCalledTimes(2)
    expect(tracked(daemon, 'startingAgents').size).toBe(0)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('handles idle cleanup rejection and allows an explicit stop to retry', async () => {
    const { daemon, logger, responses } = fixture()
    const stop = vi.fn(async (agent: AgentProcess) => { live.set(agent, false) })
      .mockRejectedValueOnce(new Error('Injected idle cleanup failure'))
    Reflect.set(daemon, 'stopAgentProcess', stop)
    await spawn(daemon, 1)
    const relay = relays[0]
    if (!relay) throw new Error('Missing managed relay')
    relay.emit('idle')
    await vi.advanceTimersByTimeAsync(0)
    expect(logger.error).toHaveBeenCalledWith('idle_suspend_failed', expect.objectContaining({
      sessionId: 'session-0',
    }))
    const managed = tracked(daemon, 'agents')
    if (!(managed instanceof Map)) throw new Error('Expected managed agent map')
    expect(managed.get('session-0')).toMatchObject({ status: 'stopping' })
    await invoke(daemon, 'handleStop', 2, { sessionId: 'session-0' })
    expect(responses).toHaveBeenLastCalledWith(2, { stopped: true, disposition: 'stopped' })
    expect(tracked(daemon, 'agents').size).toBe(0)
  })

  it('awaits every pending and managed shutdown attempt and closes sessions before exiting', async () => {
    const { daemon, logger } = fixture()
    await spawn(daemon, 1)
    await spawn(daemon, 2)
    const pending = new AgentProcess({ command: 'pending-agent-not-executed' })
    const slow = new AgentProcess({ command: 'slow-agent-not-executed' })
    pending.start()
    slow.start()
    const starting = tracked(daemon, 'startingAgents')
    if (!(starting instanceof Set)) throw new Error('Expected pending launch set')
    starting.add(pending)
    starting.add(slow)
    let complete = () => {}
    const waiting = new Promise<void>(resolve => { complete = resolve })
    const stop = vi.fn(async (agent: AgentProcess) => {
      if (agent === pending || agent === agents[0]) throw new Error('Injected shutdown failure')
      if (agent === slow) await waiting
      live.set(agent, false)
    })
    Reflect.set(daemon, 'stopAgentProcess', stop)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const close = vi.spyOn(WsClient.prototype, 'close')
    const shutdown = invoke(daemon, 'shutdown', 'test-shutdown')
    await vi.advanceTimersByTimeAsync(0)
    expect(stop).toHaveBeenCalledTimes(4)
    expect(exit).not.toHaveBeenCalled()
    complete()
    await shutdown
    expect(close).toHaveBeenCalledTimes(2)
    expect(exit).toHaveBeenCalledWith(1)
    expect(tracked(daemon, 'startingAgents').size).toBe(1)
    expect(tracked(daemon, 'agents').size).toBe(1)
    expect(logger.error).toHaveBeenCalledWith('shutdown_cleanup_failed', expect.objectContaining({
      errors: expect.arrayContaining(['Injected shutdown failure']),
    }))
  })
})
