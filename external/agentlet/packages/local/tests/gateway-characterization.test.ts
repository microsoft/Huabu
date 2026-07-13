import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AgentletMethods,
  AgentMethods,
  PROTOCOL_VERSION,
  ServerMethods,
  type AgentHelloParams,
  type AgentletHelloParams,
  type JsonRpcMessage,
} from '@agentlet/protocol'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Agentlet } from '../../local/src/agentlet.js'
import { Logger } from '../../local/src/logger.js'
import { AgentletServer } from '../../server/src/server.js'

interface Harness {
  agentletServer: AgentletServer
  httpServer: Server
  serverUrl: string
  storeDir: string
}

const harnesses: Harness[] = []
const sockets: WebSocket[] = []

function waitFor<T>(
  subscribe: (resolve: (value: T) => void) => void,
  timeout = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for event')), timeout)
    subscribe((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

async function waitUntil(
  predicate: () => boolean,
  timeout = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function startHarness(options?: {
  outboundBufferLimit?: number
  delaySessionUpgradeMs?: number
}): Promise<Harness> {
  const storeDir = mkdtempSync(join(tmpdir(), 'agentlet-characterization-'))
  const agentletServer = new AgentletServer({
    storeDir,
    outboundBufferLimit: options?.outboundBufferLimit,
    authenticate: async (token) => {
      if (token !== 'test-token') throw new Error('Invalid token')
      return { metadata: { authenticated: true } }
    },
  })
  await agentletServer.init()

  const httpServer = createServer()
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const delay =
      url.searchParams.get('role') === 'session'
        ? (options?.delaySessionUpgradeMs ?? 0)
        : 0
    if (delay > 0) {
      setTimeout(() => agentletServer.handleUpgrade(request, socket, head), delay)
    } else {
      agentletServer.handleUpgrade(request, socket, head)
    }
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as { port: number }
  const harness = {
    agentletServer,
    httpServer,
    serverUrl: `ws://127.0.0.1:${port}`,
    storeDir,
  }
  harnesses.push(harness)
  return harness
}

async function connect(
  serverUrl: string,
  role: 'agentlet' | 'session',
  id: string,
  hello: JsonRpcMessage,
): Promise<{ socket: WebSocket; messages: JsonRpcMessage[] }> {
  const socket = new WebSocket(
    `${serverUrl}?token=test-token&role=${role}&id=${encodeURIComponent(id)}`,
  )
  sockets.push(socket)
  const messages: JsonRpcMessage[] = []
  socket.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as JsonRpcMessage)
  })
  await waitFor<void>((resolve) => socket.once('open', resolve))
  socket.send(JSON.stringify(hello))
  await waitUntil(() => messages.some((message) => 'id' in message && message.id === 1))
  return { socket, messages }
}

function agentletHello(agentletId: string): JsonRpcMessage {
  const params: AgentletHelloParams = {
    agentletId,
    agentletProfile: {
      bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
      machine: { hostname: agentletId, platform: process.platform },
      capabilities: { autoRestart: true, bufferLimit: 1000, maxAgents: 10 },
    },
  }
  return {
    jsonrpc: '2.0',
    method: AgentletMethods.HELLO,
    id: 1,
    params: params as unknown as Record<string, unknown>,
  }
}

function sessionHello(sessionId: string, agentletId: string): JsonRpcMessage {
  const params: AgentHelloParams = {
    sessionId,
    sessionProfile: {
      agentletId,
      bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
      agent: { command: 'mock-agent', pid: 123, cwd: process.cwd() },
      capabilities: { autoRestart: false, bufferLimit: 1000 },
    },
  }
  return {
    jsonrpc: '2.0',
    method: AgentMethods.HELLO,
    id: 1,
    params: params as unknown as Record<string, unknown>,
  }
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close()
    }
  }
  for (const harness of harnesses.splice(0)) {
    await harness.agentletServer.close()
    await new Promise<void>((resolve) => harness.httpServer.close(() => resolve()))
    rmSync(harness.storeDir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe.sequential('Gateway migration characterization', () => {
  it('registers control and session hello as separate connection roles', async () => {
    const { agentletServer, serverUrl } = await startHarness()

    await connect(serverUrl, 'agentlet', 'machine-a', agentletHello('machine-a'))
    await connect(
      serverUrl,
      'session',
      'native-session-a',
      sessionHello('native-session-a', 'machine-a'),
    )

    expect(agentletServer.getAgentlets()).toHaveLength(1)
    expect(agentletServer.getAgentlets()[0]).toMatchObject({
      sessionId: 'machine-a',
      agentletId: 'machine-a',
      role: 'agentlet',
      status: 'connected',
    })
    expect(agentletServer.getAgentSessions()).toHaveLength(1)
    expect(agentletServer.getAgentSessions()[0]).toMatchObject({
      sessionId: 'native-session-a',
      agentletId: 'machine-a',
      role: 'agent-session',
      status: 'connected',
    })
  })

  it('resolves spawn from the control response before a session connection exists', async () => {
    const { agentletServer, serverUrl } = await startHarness()
    const control = await connect(
      serverUrl,
      'agentlet',
      'machine-a',
      agentletHello('machine-a'),
    )
    control.socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as JsonRpcMessage
      if (
        'method' in message &&
        message.method === ServerMethods.SPAWN &&
        'id' in message
      ) {
        control.socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { sessionId: 'native-session-a', pid: 321 },
          }),
        )
      }
    })

    await expect(
      agentletServer.spawnOnAgentlet('machine-a', {
        appId: 'thread-a',
        sessionSpec: { command: 'mock-agent' },
      }),
    ).resolves.toEqual({ sessionId: 'native-session-a', pid: 321 })
    expect(agentletServer.getConnection('native-session-a')).toBeUndefined()
  })

  it('buffers outbound messages while disconnected and flushes them on reconnect', async () => {
    const { agentletServer, serverUrl } = await startHarness({
      outboundBufferLimit: 2,
    })
    const first = await connect(
      serverUrl,
      'session',
      'native-session-a',
      sessionHello('native-session-a', 'machine-a'),
    )
    first.socket.close()
    await waitUntil(
      () => agentletServer.getConnection('native-session-a')?.status === 'disconnected',
    )

    const connection = agentletServer.getConnection('native-session-a')
    connection?.send({
      jsonrpc: '2.0',
      method: 'session/prompt',
      id: 41,
      params: {},
    })

    const second = await connect(
      serverUrl,
      'session',
      'native-session-a',
      sessionHello('native-session-a', 'machine-a'),
    )
    await waitUntil(() =>
      second.messages.some(
        (message) => 'method' in message && message.method === ServerMethods.REPLAY,
      ),
    )
    const replay = second.messages.find(
      (message) => 'method' in message && message.method === ServerMethods.REPLAY,
    )
    expect(replay).toMatchObject({
      method: ServerMethods.REPLAY,
      params: {
        messages: [{ id: 41, method: 'session/prompt' }],
      },
    })
  })

  it('keeps a session connected when its control socket disconnects', async () => {
    const { agentletServer, serverUrl } = await startHarness()
    const control = await connect(
      serverUrl,
      'agentlet',
      'machine-a',
      agentletHello('machine-a'),
    )
    await connect(
      serverUrl,
      'session',
      'native-session-a',
      sessionHello('native-session-a', 'machine-a'),
    )

    control.socket.close()
    await waitUntil(
      () => agentletServer.getConnection('machine-a')?.status === 'disconnected',
    )
    expect(agentletServer.getConnection('native-session-a')?.status).toBe(
      'connected',
    )
  })

  it('returns spawn before delayed session readiness and persists bootstrap updates', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    const { agentletServer, serverUrl, storeDir } = await startHarness({
      delaySessionUpgradeMs: 500,
    })
    const mockAgentPath = join(storeDir, 'mock-acp-agent.cjs')
    writeFileSync(
      mockAgentPath,
      [
        "const readline = require('node:readline')",
        "const rl = readline.createInterface({ input: process.stdin })",
        "rl.on('line', (line) => {",
        '  const message = JSON.parse(line)',
        "  if (message.method === 'initialize') {",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'mock-agent', version: '1.0.0' } } }) + '\\n')",
        "  } else if (message.method === 'session/new') {",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-bootstrap', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes', input: null }] } } }) + '\\n')",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'native-bootstrap' } }) + '\\n')",
        '  }',
        '})',
      ].join('\n'),
    )
    const daemon = new Agentlet(
      {
        server: serverUrl,
        token: 'test-token',
        reconnectMax: 1,
        bufferLimit: 1000,
        heartbeat: 0,
        allowInsecure: true,
        logLevel: 'error',
        cwd: process.cwd(),
        env: {},
        autoRestart: false,
        restartDelay: 100,
        restartMax: 0,
        agentletId: 'machine-a',
        maxAgents: 10,
      },
      new Logger('error'),
    )
    await daemon.start()
    await waitUntil(
      () => agentletServer.getConnection('machine-a')?.status === 'connected',
    )

    const spawn = await agentletServer.spawnOnAgentlet('machine-a', {
      appId: 'thread-a',
      sessionSpec: { command: `node ${JSON.stringify(mockAgentPath)}` },
    })
    expect(spawn).toEqual({ sessionId: 'native-bootstrap', pid: expect.any(Number) })
    expect(agentletServer.getConnection('native-bootstrap')).toBeUndefined()

    await waitUntil(
      () => agentletServer.getConnection('native-bootstrap')?.status === 'connected',
    )
    await waitUntil(() =>
      agentletServer
        .getEventStore()
        .getEventsSince('native-bootstrap', 0)
        .some(
          (event) =>
            event.dir === 'agent' &&
            'method' in event.event &&
            event.event.method === 'session/update',
        ),
    )

    agentletServer.getConnection('native-bootstrap')?.disconnect('test_disconnect')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(agentletServer.getConnection('native-bootstrap')?.status).toBe(
      'disconnected',
    )

    await agentletServer.stopOnAgentlet('machine-a', {
      sessionId: 'native-bootstrap',
    })
    agentletServer.getConnection('machine-a')?.disconnect('test_complete')
    await waitUntil(() => exitSpy.mock.calls.length > 0)
  }, 15_000)
})
