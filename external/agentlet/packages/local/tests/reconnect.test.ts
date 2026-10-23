import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agentlet } from '../src/agentlet.js'
import { parseCli } from '../src/cli.js'
import { Logger } from '../src/logger.js'

interface ControlSocket extends EventEmitter {
  readyState: number
  close(): void
  terminate(): void
}

const sockets = vi.hoisted(() => [] as ControlSocket[])

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    default: class extends EventEmitter {
      static OPEN = 1
      readyState = 0
      constructor() {
        super()
        sockets.push(this)
      }
      send() {}
      close() {
        this.readyState = 3
        this.emit('close', 1000, Buffer.from('closed'))
      }
      terminate() {
        this.close()
      }
    },
  }
})

const initialSignals = {
  SIGINT: process.listeners('SIGINT'),
  SIGTERM: process.listeners('SIGTERM'),
}

function currentSocket(): ControlSocket {
  const socket = sockets.at(-1)
  if (!socket) throw new Error('Expected a control socket')
  return socket
}

function handshake(): void {
  const socket = currentSocket()
  socket.readyState = 1
  socket.emit('open')
  socket.emit('message', Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: 1, result: { sessionId: 'machine-a' },
  })), false)
}

async function startDaemon(onEntry?: ConstructorParameters<typeof Logger>[2]): Promise<Logger> {
  const logger = new Logger('error', undefined, onEntry)
  vi.spyOn(logger, 'error').mockImplementation(() => undefined)
  const daemon = new Agentlet({
    server: 'ws://127.0.0.1:3001/bridge', token: 'test-token',
    reconnectMax: 30, bufferLimit: 1000, heartbeat: 0, allowInsecure: true,
    logLevel: 'error', agentletId: 'machine-a', maxAgents: 1,
  }, logger)
  await daemon.start()
  return logger
}

beforeEach(() => {
  sockets.length = 0
  vi.useFakeTimers()
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
})

afterEach(async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!initialSignals[signal].includes(listener)) {
        if (signal === 'SIGTERM') listener(signal)
        process.removeListener(signal, listener)
      }
    }
  }
  await vi.advanceTimersByTimeAsync(0)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('control reconnect lifecycle', () => {
  it('reports the device identity rather than the server session ID on readiness', async () => {
    const onEntry = vi.fn()
    await startDaemon(onEntry)
    const socket = currentSocket()
    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { sessionId: 'control-session' },
    })), false)
    expect(onEntry).toHaveBeenCalledWith(expect.objectContaining({
      event: 'daemon_ready', agentletId: 'machine-a', daemonId: 'control-session',
    }))
  })

  it('uses exact exponential delays capped at 30 seconds and resets after a successful handshake', async () => {
    await startDaemon()
    handshake()
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      currentSocket().close()
      const attempts = sockets.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(sockets).toHaveLength(attempts)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(attempts + 1)
    }
    handshake()
    currentSocket().close()
    const attempts = sockets.length
    await vi.advanceTimersByTimeAsync(999)
    expect(sockets).toHaveLength(attempts)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(attempts + 1)
  })

  it('reconnects after server shutdown without exiting or scheduling duplicate attempts', async () => {
    await startDaemon()
    handshake()
    const socket = currentSocket()
    socket.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', method: 'server/shutdown', params: { reason: 'server_shutting_down' },
    })), false)
    await vi.advanceTimersByTimeAsync(0)
    expect(process.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2)
    handshake()
    socket.emit('close', 1001, Buffer.from('server_shutting_down'))
    await vi.advanceTimersByTimeAsync(30000)
    expect(sockets).toHaveLength(2)
  })

  it('cancels pending reconnect when the user stops the daemon', async () => {
    await startDaemon()
    handshake()
    currentSocket().close()
    const stop = process.listeners('SIGTERM').find(
      listener => !initialSignals.SIGTERM.includes(listener),
    )
    if (!stop) throw new Error('Expected daemon SIGTERM handler')
    stop('SIGTERM')
    await vi.advanceTimersByTimeAsync(30000)
    expect(process.exit).toHaveBeenCalledWith(0)
    expect(sockets).toHaveLength(1)
  })

  it.each([401, 403])('stops with actionable guidance after HTTP %i instead of retrying', async (statusCode) => {
    const logger = await startDaemon()
    currentSocket().emit('unexpected-response', {}, { statusCode, resume() {} })
    await vi.advanceTimersByTimeAsync(30000)
    expect(process.exit).toHaveBeenCalledWith(1)
    expect(logger.error).toHaveBeenCalledWith('authentication_failed', expect.objectContaining({
      message: expect.stringContaining('Copy a new connection command'),
    }))
    expect(sockets).toHaveLength(1)
  })

  it('retries a transient HTTP upgrade failure', async () => {
    await startDaemon()
    currentSocket().emit('unexpected-response', {}, { statusCode: 503, resume() {} })
    await vi.advanceTimersByTimeAsync(1000)
    expect(process.exit).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(2)
  })

  it('retries a stalled connection without waiting for a peer close', async () => {
    await startDaemon()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2)
    handshake()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sockets).toHaveLength(2)
  })
})

describe('reconnect CLI defaults', () => {
  const args = ['node', 'agentlet', 'daemon', '--server', 'wss://host.example/bridge', '--token', 'test-token']

  it('defaults to a 30-second maximum and accepts an explicit override', () => {
    expect(parseCli(args).options.reconnectMax).toBe(30)
    expect(parseCli([...args, '--reconnect-max', '7']).options.reconnectMax).toBe(7)
  })

  it.each(['0', '-1', '1.5', 'invalid'])('rejects invalid reconnect intervals: %s', value => {
    expect(() => parseCli([...args, '--reconnect-max', value])).toThrow('--reconnect-max must be a positive safe integer')
  })
})
