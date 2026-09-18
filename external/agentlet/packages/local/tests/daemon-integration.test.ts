import { createServer, type Server } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  AgentMethods,
  AgentletMethods,
  ServerMethods,
  type AgentHelloParams,
  type AgentletHelloParams,
  type JsonRpcMessage,
} from '@agentlet/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { Agentlet } from '../src/agentlet.js'
import { Logger } from '../src/logger.js'

function waitUntil(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) return resolve()
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for condition'))
      setTimeout(poll, 10)
    }
    poll()
  })
}

describe('agentlet daemon integration', () => {
  let httpServer: Server | undefined
  let gateway: WebSocketServer | undefined
  let controlSocket: WebSocket | undefined
  let sessionSocket: WebSocket | undefined
  let exitSpy: ReturnType<typeof vi.spyOn> | undefined
  let fixtureDir: string | undefined
  const initialSigint = process.listeners('SIGINT')
  const initialSigterm = process.listeners('SIGTERM')

  afterEach(async () => {
    if (controlSocket?.readyState === WebSocket.OPEN) {
      controlSocket.send(JSON.stringify({
        jsonrpc: '2.0', method: ServerMethods.SHUTDOWN, params: { reason: 'test_complete' },
      }))
      await waitUntil(() => (exitSpy?.mock.calls.length ?? 0) > 0).catch(() => undefined)
    }
    sessionSocket?.close()
    controlSocket?.close()
    gateway?.close()
    await new Promise<void>((resolve) => {
      if (!httpServer?.listening) return resolve()
      httpServer.close(() => resolve())
    })
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
    exitSpy?.mockRestore()
    for (const listener of process.listeners('SIGINT')) {
      if (!initialSigint.includes(listener)) process.removeListener('SIGINT', listener)
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!initialSigterm.includes(listener)) process.removeListener('SIGTERM', listener)
    }
  })

  it('advertises discovery, refuses retired Team calls, and preserves generic ACP launch', async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    fixtureDir = join(process.cwd(), `.agentlet-daemon-test-${randomUUID()}`)
    mkdirSync(fixtureDir)
    const mockAgentPath = join(fixtureDir, 'mock-acp-agent.cjs')
    writeFileSync(mockAgentPath, [
      "const readline = require('node:readline')",
      'const rl = readline.createInterface({ input: process.stdin })',
      "rl.on('line', (line) => {",
      '  const message = JSON.parse(line)',
      "  if (message.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'mock-agent', version: '1.0.0' } } }) + '\\n')",
      "  } else if (message.method === 'session/new') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-bootstrap', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes', input: null }] } } }) + '\\n')",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'native-bootstrap' } }) + '\\n')",
      '  }',
      '})',
    ].join('\n'))

    const controlMessages: JsonRpcMessage[] = []
    const sessionMessages: JsonRpcMessage[] = []
    let controlHello: AgentletHelloParams | undefined
    let sessionHello: AgentHelloParams | undefined
    gateway = new WebSocketServer({ noServer: true })
    httpServer = createServer()
    httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const accept = (): void => {
        gateway?.handleUpgrade(request, socket, head, (webSocket) => {
          gateway?.emit('connection', webSocket, request)
        })
      }
      if (url.searchParams.get('role') === 'session') setTimeout(accept, 200)
      else accept()
    })
    gateway.on('connection', (socket, request) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const role = url.searchParams.get('role')
      expect(url.searchParams.get('token')).toBe('test-token')
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as JsonRpcMessage
        if (role === 'agentlet') {
          controlSocket = socket
          controlMessages.push(message)
          if ('method' in message && message.method === AgentletMethods.HELLO) {
            controlHello = message.params as unknown as AgentletHelloParams
            socket.send(JSON.stringify({
              jsonrpc: '2.0', id: message.id,
              result: { agentletId: 'machine-a', status: 'registered' },
            }))
          }
          return
        }
        sessionSocket = socket
        sessionMessages.push(message)
        if ('method' in message && message.method === AgentMethods.HELLO) {
          sessionHello = message.params as unknown as AgentHelloParams
          socket.send(JSON.stringify({
            jsonrpc: '2.0', id: message.id,
            result: { sessionId: 'native-bootstrap', status: 'connected' },
          }))
        }
      })
    })
    await new Promise<void>((resolve) => httpServer?.listen(0, '127.0.0.1', resolve))
    const { port } = httpServer.address() as { port: number }
    const daemon = new Agentlet({
      server: `ws://127.0.0.1:${port}/api/bridge`, token: 'test-token',
      reconnectMax: 1, bufferLimit: 1000, heartbeat: 0, allowInsecure: true,
      logLevel: 'error', agentletId: 'machine-a', maxAgents: 10,
    }, new Logger('error'))
    await daemon.start()
    await waitUntil(() => controlHello !== undefined)
    expect(controlHello).toMatchObject({
      agentletId: 'machine-a',
      agentletProfile: {
        machine: { hostname: 'machine-a' },
        capabilities: { harnessDiscovery: { version: 1 } },
      },
    })

    async function request(id: number, method: string, params: Record<string, unknown>) {
      controlSocket?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      await waitUntil(() => controlMessages.some((message) => 'id' in message && message.id === id))
      return controlMessages.find((message) => 'id' in message && message.id === id)
    }
    expect(await request(7, 'agent-team/scan', {})).toMatchObject({ error: { code: -32601 } })
    expect(await request(8, ServerMethods.SPAWN, {
      sessionSpec: { command: 'must-not-run', agentTeam: { agentDir: fixtureDir } },
    })).toMatchObject({ error: { code: -32602, message: expect.stringContaining('agentTeam') } })
    expect(await request(9, ServerMethods.DISCOVER_HARNESSES, {
      rootPath: fixtureDir,
    })).toMatchObject({ error: { code: -32602 } })

    expect(await request(10, ServerMethods.SPAWN, {
      appId: 'thread-a', sessionSpec: { command: `node ${JSON.stringify(mockAgentPath)}` },
    })).toMatchObject({ result: { sessionId: 'native-bootstrap', pid: expect.any(Number) } })
    expect(sessionSocket).toBeUndefined()
    await waitUntil(() => sessionHello !== undefined)
    expect(sessionHello).toMatchObject({
      sessionId: 'native-bootstrap',
      sessionProfile: { agentletId: 'machine-a', machine: { hostname: 'machine-a' } },
    })
    await waitUntil(() => sessionMessages.some(
      (message) => 'method' in message && message.method === 'session/update',
    ))
    expect(await request(11, ServerMethods.STOP, { sessionId: 'native-bootstrap' }))
      .toMatchObject({ result: { stopped: true } })
  }, 15_000)
})
