import { createServer, type Server } from 'node:http'
import { arch, hostname, platform } from 'node:os'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const ownedPids: number[] = []
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
    for (const pid of ownedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
    }
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
    const envPath = join(fixtureDir, 'environment.json')
    writeFileSync(mockAgentPath, [
      `require('node:fs').writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({ entry: process.env.TOOL_ENTRY, token: process.env.AGENTLET_TOKEN, rfs: process.env.HUABU_RFS_URL, thread: process.env.HUABU_THREAD_ID }))`,
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
    const bootstrapEnv = { TOOL_ENTRY: ' relative entry=a=b ', RESOURCE_DIR: fixtureDir }
    const daemon = new Agentlet({
      server: `ws://127.0.0.1:${port}/api/bridge`, token: 'test-token',
      reconnectMax: 1, bufferLimit: 1000, heartbeat: 0, allowInsecure: true,
      logLevel: 'error', agentletId: 'machine-a', maxAgents: 1,
      bootstrapEnv,
    }, new Logger('error'))
    bootstrapEnv.TOOL_ENTRY = 'must-not-change'
    await daemon.start()
    await waitUntil(() => controlHello !== undefined)
    expect(controlHello).toMatchObject({
      agentletId: 'machine-a',
      agentletProfile: {
        machine: { hostname: hostname(), platform: platform(), arch: arch() },
        capabilities: {
          harnessDiscovery: { version: 2 },
          harnessLaunch: { version: 2 },
        },
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

    for (const [id, env] of [[20, { TOOL_ENTRY: ' relative entry=a=b ' }], [21, { AGENTLET_TOKEN: 'test-token' }]] as const) {
      expect(await request(id, ServerMethods.SPAWN, {
        appId: 'invalid-env', sessionSpec: { command: `node ${JSON.stringify(mockAgentPath)}`, env },
      })).toMatchObject({ error: { code: -32602, message: expect.stringContaining('protected environment key') } })
      expect(existsSync(envPath)).toBe(false)
    }
    controlSocket?.send(JSON.stringify({
      jsonrpc: '2.0', method: ServerMethods.SEND_RESOURCE,
      params: { destination: '${RESOURCE_DIR}/resource.txt', content: 'explicit resource' },
    }))
    await waitUntil(() => existsSync(join(fixtureDir!, 'resource.txt')))
    expect(readFileSync(join(fixtureDir, 'resource.txt'), 'utf8')).toBe('explicit resource')

    expect(await request(10, ServerMethods.SPAWN, {
      appId: 'thread-a', workloadType: 'Job',
      sessionSpec: { command: `node ${JSON.stringify(mockAgentPath)}`, env: {
        HUABU_RFS_URL: 'http://host/rfs/space', HUABU_THREAD_ID: 'thread-a',
      } },
    })).toMatchObject({ result: { sessionId: 'native-bootstrap', pid: expect.any(Number) } })
    expect(JSON.parse(readFileSync(envPath, 'utf8'))).toEqual({
      entry: ' relative entry=a=b ', token: 'test-token', rfs: 'http://host/rfs/space', thread: 'thread-a',
    })
    expect(sessionSocket).toBeUndefined()
    await waitUntil(() => sessionHello !== undefined)
    expect(sessionHello).toMatchObject({
      sessionId: 'native-bootstrap',
      sessionProfile: {
        agentletId: 'machine-a',
        machine: { hostname: hostname(), platform: platform(), arch: arch() },
      },
    })
    await waitUntil(() => sessionMessages.some(
      (message) => 'method' in message && message.method === 'session/update',
    ))
    expect(await request(11, ServerMethods.SPAWN, {
      appId: 'thread-b', workloadType: 'Deployment',
      sessionSpec: { command: `node ${JSON.stringify(mockAgentPath)}` },
    })).toMatchObject({
      error: {
        data: {
          code: 'capacity_exhausted',
          limit: 1,
          active: {
            total: 1,
            jobs: 1,
            deployments: 0,
            unknown: 0,
            stopping: 0,
          },
        },
      },
    })
    expect(await request(12, ServerMethods.STOP, { sessionId: 'native-bootstrap' }))
      .toMatchObject({ result: { stopped: true, disposition: 'stopped' } })
    expect(await request(13, ServerMethods.STOP, { sessionId: 'native-bootstrap' }))
      .toMatchObject({ result: { stopped: true, disposition: 'already_absent' } })
    expect(await request(14, ServerMethods.SPAWN, {
      appId: 'thread-c', workloadType: 'Deployment',
      sessionSpec: { command: `node ${JSON.stringify(mockAgentPath)}` },
    })).toMatchObject({ result: { sessionId: 'native-bootstrap', pid: expect.any(Number) } })
    expect(await request(15, ServerMethods.STOP, { sessionId: 'native-bootstrap' }))
      .toMatchObject({ result: { stopped: true } })
    const restartAgentPath = join(fixtureDir, 'restart-agent.cjs')
    const restartPidsPath = join(fixtureDir, 'restart-pids.json')
    if (process.platform !== 'win32') {
      writeFileSync(restartAgentPath, [
        readFileSync(mockAgentPath, 'utf8'),
        "process.on('SIGTERM', () => {})",
        'setInterval(() => {}, 1000)',
        "const { spawn } = require('node:child_process')",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready')")}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })`,
        "child.on('message', () => require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, childPid: child.pid })))",
      ].join('\n'))
    }
    expect(await request(16, ServerMethods.SPAWN, {
      appId: 'thread-before-restart',
      sessionSpec: {
        command: `node ${JSON.stringify(process.platform === 'win32' ? mockAgentPath : restartAgentPath)} ${JSON.stringify(restartPidsPath)}`,
        autoRestart: true,
      },
    })).toMatchObject({ result: { sessionId: 'native-bootstrap' } })
    if (process.platform !== 'win32') {
      await waitUntil(() => existsSync(restartPidsPath))
      const pids: { pid: number; childPid: number } = JSON.parse(readFileSync(restartPidsPath, 'utf8'))
      ownedPids.push(pids.pid, pids.childPid)
    }
    await waitUntil(() => sessionSocket?.readyState === WebSocket.OPEN)
    const oldControlSocket = controlSocket
    const oldSessionSocket = sessionSocket
    const helloCount = () => controlMessages.filter(
      message => 'method' in message && message.method === AgentletMethods.HELLO,
    ).length
    const beforeRestart = helloCount()
    controlSocket?.send(JSON.stringify({
      jsonrpc: '2.0', method: ServerMethods.SHUTDOWN, params: { reason: 'server_shutting_down' },
    }))
    await waitUntil(() => oldControlSocket?.readyState === WebSocket.CLOSED)
    await waitUntil(() => oldSessionSocket?.readyState === WebSocket.CLOSED, 10_000)
    await new Promise<void>((resolve, reject) =>
      httpServer?.close(error => error ? reject(error) : resolve()),
    )
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(exitSpy).not.toHaveBeenCalled()
    await new Promise<void>(resolve => httpServer?.listen(port, '127.0.0.1', resolve))
    await waitUntil(() => helloCount() > beforeRestart)
    for (const pid of ownedPids) expect(() => process.kill(pid, 0)).toThrow()
    ownedPids.length = 0
    expect(controlHello?.agentletId).toBe('machine-a')
    expect(await request(17, ServerMethods.LIST, {})).toMatchObject({ result: { agents: [] } })
    const beforeSessionLoss = sessionSocket
    expect(await request(18, ServerMethods.SPAWN, {
      appId: 'thread-after-restart',
      sessionSpec: { command: `node ${JSON.stringify(mockAgentPath)}` },
    })).toMatchObject({ result: { sessionId: 'native-bootstrap' } })
    await waitUntil(() => sessionSocket !== beforeSessionLoss && sessionSocket?.readyState === WebSocket.OPEN)
    sessionSocket?.terminate()
    let afterSessionLoss: JsonRpcMessage | undefined
    for (let attempt = 0; attempt < 50; attempt++) {
      afterSessionLoss = await request(200 + attempt, ServerMethods.LIST, {})
      if (afterSessionLoss && 'result' in afterSessionLoss &&
        typeof afterSessionLoss.result === 'object' && afterSessionLoss.result !== null &&
        'agents' in afterSessionLoss.result && Array.isArray(afterSessionLoss.result.agents) &&
        afterSessionLoss.result.agents.length === 0) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(afterSessionLoss).toMatchObject({ result: { agents: [] } })
    expect(await request(19, ServerMethods.STOP, { sessionId: 'native-bootstrap' }))
      .toMatchObject({ result: { stopped: true, disposition: 'already_absent' } })
    const pendingAgentPath = join(fixtureDir, 'pending-agent.cjs')
    const pendingStarted = join(fixtureDir, 'pending-started')
    writeFileSync(pendingAgentPath, [
      `require('node:fs').writeFileSync(${JSON.stringify(pendingStarted)}, 'started')`,
      'process.stdin.resume()',
    ].join('\n'))
    controlSocket?.send(JSON.stringify({
      jsonrpc: '2.0', id: 100, method: ServerMethods.SPAWN,
      params: { sessionSpec: { command: `node ${JSON.stringify(pendingAgentPath)}` } },
    }))
    await waitUntil(() => existsSync(pendingStarted))
    const beforePendingRestart = helloCount()
    controlSocket?.send(JSON.stringify({
      jsonrpc: '2.0', method: ServerMethods.SHUTDOWN, params: { reason: 'server_shutting_down' },
    }))
    await waitUntil(() => helloCount() > beforePendingRestart)
    expect(await request(101, ServerMethods.LIST, {})).toMatchObject({ result: { agents: [] } })
    expect(await request(102, ServerMethods.SPAWN, {
      appId: 'thread-after-pending-restart',
      sessionSpec: { command: `node ${JSON.stringify(mockAgentPath)}` },
    })).toMatchObject({ result: { sessionId: 'native-bootstrap' } })
    expect(await request(103, ServerMethods.STOP, { sessionId: 'native-bootstrap' }))
      .toMatchObject({ result: { stopped: true } })
    controlSocket?.send(JSON.stringify({ jsonrpc: '2.0', method: ServerMethods.SHUTDOWN }))
    await waitUntil(() => (exitSpy?.mock.calls.length ?? 0) > 0)
    expect(exitSpy).toHaveBeenCalledWith(0)
  }, 30_000)

  it('exits nonzero when the control handshake is rejected', async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    httpServer = createServer()
    gateway = new WebSocketServer({ server: httpServer })
    gateway.on('connection', socket => {
      controlSocket = socket
      socket.on('message', data => {
        const message = JSON.parse(data.toString()) as JsonRpcMessage
        if ('method' in message && message.method === AgentletMethods.HELLO) {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication rejected' } }))
        }
      })
    })
    await new Promise<void>(resolve => httpServer?.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    const daemon = new Agentlet({
      server: `ws://127.0.0.1:${address.port}/bridge`, token: 'test-token',
      reconnectMax: 1, bufferLimit: 1000, heartbeat: 0, allowInsecure: true,
      logLevel: 'error', agentletId: 'machine-a', maxAgents: 1,
    }, new Logger('error'))
    await daemon.start()
    await waitUntil(() => (exitSpy?.mock.calls.length ?? 0) > 0)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
