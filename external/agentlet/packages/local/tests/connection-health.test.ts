import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { monitorConnection } from '../src/connection-health.js'

afterEach(() => vi.useRealTimers())

describe('connection health watchdog', () => {
  async function connect(autoPong: boolean) {
    const server = createServer()
    const gateway = new WebSocketServer({ server, autoPong })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
    const health = monitorConnection(client, 0.02)
    const closed = new Promise<void>(resolve => client.once('close', () => resolve()))
    await new Promise<void>(resolve => client.once('open', resolve))
    health.handshakeComplete()
    return {
      client, closed, health,
      cleanup: async () => {
        client.terminate()
        await closed
        for (const socket of gateway.clients) socket.terminate()
        await new Promise<void>(resolve => gateway.close(() => resolve()))
        await new Promise<void>(resolve => server.close(() => resolve()))
      },
    }
  }

  it('terminates a half-open connection even when no close event arrives from the peer', async () => {
    const connection = await connect(false)
    try {
      await connection.closed
      expect(connection.client.readyState).toBe(WebSocket.CLOSED)
    } finally {
      await connection.cleanup()
    }
  })

  it('keeps a responsive connection alive', async () => {
    const connection = await connect(true)
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(connection.client.readyState).toBe(WebSocket.OPEN)
    } finally {
      await connection.cleanup()
    }
  })

  it('bounds an application handshake and clears its timers on close', async () => {
    const connection = await connect(true)
    connection.health.stop()
    try {
      vi.useFakeTimers()
      const terminate = vi.spyOn(connection.client, 'terminate')
      const health = monitorConnection(connection.client, 0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(terminate).toHaveBeenCalledTimes(1)
      health.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      await connection.cleanup()
    }
  })
})
