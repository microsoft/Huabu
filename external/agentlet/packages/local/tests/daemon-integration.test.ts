import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error('Timed out waiting for condition'))
        return
      }
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
  let tempDir: string | undefined

  afterEach(async () => {
    if (controlSocket?.readyState === WebSocket.OPEN) {
      controlSocket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: ServerMethods.SHUTDOWN,
          params: { reason: 'test_complete' },
        }),
      )
      await waitUntil(() => (exitSpy?.mock.calls.length ?? 0) > 0).catch(
        () => undefined,
      )
    }
    sessionSocket?.close()
    controlSocket?.close()
    gateway?.close()
    await new Promise<void>((resolve) => {
      if (!httpServer?.listening) {
        resolve()
        return
      }
      httpServer.close(() => resolve())
    })
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    exitSpy?.mockRestore()
  })

  it('scans Agent Teams, spawns, bootstraps, and flushes pre-attach ACP updates', async () => {
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    tempDir = mkdtempSync(join(tmpdir(), 'agentlet-daemon-test-'))
    const mockAgentPath = join(tempDir, 'mock-acp-agent.cjs')
    writeFileSync(
      mockAgentPath,
      [
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
      ].join('\n'),
    )
    const teamsRoot = join(tempDir, 'teams')
    const reviewerDir = join(teamsRoot, 'reviewer')
    mkdirSync(reviewerDir, { recursive: true })
    writeFileSync(
      join(reviewerDir, 'agentlet.yaml'),
      [
        'schema: agentlet-agent-schema-v1',
        'name: reviewer',
        'description: Reviews changes',
        'command:',
        '  copilot: copilot --acp',
      ].join('\n'),
    )
    const cancellableDir = join(teamsRoot, 'cancellable')
    mkdirSync(cancellableDir)
    writeFileSync(
      join(cancellableDir, 'agentlet.yaml'),
      [
        'schema: agentlet-agent-schema-v1',
        'name: cancellable',
        'description: Exercises setup cancellation',
        'command:',
        '  copilot: copilot --acp',
        'onInstall: ./hang.mjs',
      ].join('\n'),
    )
    writeFileSync(
      join(cancellableDir, 'hang.mjs'),
      'export default async function () { await new Promise(() => setInterval(() => {}, 1000)) }',
    )

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
      if (url.searchParams.get('role') === 'session') {
        setTimeout(accept, 200)
      } else {
        accept()
      }
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
          if (
            'method' in message &&
            message.method === AgentletMethods.HELLO
          ) {
            controlHello = message.params as unknown as AgentletHelloParams
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: { agentletId: 'machine-a', status: 'registered' },
              }),
            )
          }
          return
        }

        sessionSocket = socket
        sessionMessages.push(message)
        if ('method' in message && message.method === AgentMethods.HELLO) {
          sessionHello = message.params as unknown as AgentHelloParams
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { sessionId: 'native-bootstrap', status: 'connected' },
            }),
          )
        }
      })
    })
    await new Promise<void>((resolve) =>
      httpServer?.listen(0, '127.0.0.1', resolve),
    )
    const { port } = httpServer.address() as { port: number }

    const daemon = new Agentlet(
      {
        server: `ws://127.0.0.1:${port}/api/bridge`,
        token: 'test-token',
        reconnectMax: 1,
        bufferLimit: 1000,
        heartbeat: 0,
        allowInsecure: true,
        logLevel: 'error',
        agentletId: 'machine-a',
        maxAgents: 10,
      },
      new Logger('error'),
    )
    await daemon.start()
    await waitUntil(() => controlHello !== undefined)

    controlSocket?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: ServerMethods.AGENT_TEAM_SCAN,
        id: 9,
        params: { rootPath: teamsRoot },
      }),
    )
    await waitUntil(() =>
      controlMessages.some(
        (message) => 'id' in message && message.id === 9 && 'result' in message,
      ),
    )
    expect(
      controlMessages.find((message) => 'id' in message && message.id === 9),
    ).toMatchObject({
      result: {
        rootPath: teamsRoot,
        members: expect.arrayContaining([
          expect.objectContaining({
            name: 'reviewer',
            manifestPath: join(reviewerDir, 'agentlet.yaml'),
            harnesses: ['copilot'],
          }),
        ]),
        diagnostics: [],
      },
    })

    const reviewerWorkspace = join(reviewerDir, 'workspaces', 'copilot')
    controlSocket?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: ServerMethods.AGENT_TEAM_SETUP,
        id: 20,
        params: {
          operationId: 'setup-complete',
          manifestPath: join(reviewerDir, 'agentlet.yaml'),
          harness: 'copilot',
          workingDirPath: reviewerWorkspace,
        },
      }),
    )
    await waitUntil(() =>
      controlMessages.some(
        (message) => 'id' in message && message.id === 20 && 'result' in message,
      ),
    )
    expect(
      controlMessages.find((message) => 'id' in message && message.id === 20),
    ).toMatchObject({
      result: {
        operationId: 'setup-complete',
        accepted: true,
      },
    })
    await waitUntil(() =>
      controlMessages.some(
        (message) =>
          'method' in message &&
          message.method === AgentletMethods.AGENT_TEAM_SETUP_PROGRESS &&
          message.params?.operationId === 'setup-complete' &&
          message.params?.type === 'completed',
      ),
    )

    controlSocket?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: ServerMethods.AGENT_TEAM_VALIDATE,
        id: 21,
        params: {
          manifestPath: join(reviewerDir, 'agentlet.yaml'),
          harness: 'copilot',
          workingDirPath: reviewerWorkspace,
        },
      }),
    )
    await waitUntil(() =>
      controlMessages.some(
        (message) => 'id' in message && message.id === 21 && 'result' in message,
      ),
    )
    expect(
      controlMessages.find((message) => 'id' in message && message.id === 21),
    ).toMatchObject({ result: { valid: true, issues: [] } })

    const cancellableWorkspace = join(tempDir, 'deployments', 'cancellable')
    controlSocket?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: ServerMethods.AGENT_TEAM_SETUP,
        id: 22,
        params: {
          operationId: 'setup-cancel',
          manifestPath: join(cancellableDir, 'agentlet.yaml'),
          harness: 'copilot',
          workingDirPath: cancellableWorkspace,
        },
      }),
    )
    await waitUntil(() =>
      controlMessages.some(
        (message) =>
          'method' in message &&
          message.method === AgentletMethods.AGENT_TEAM_SETUP_PROGRESS &&
          message.params?.operationId === 'setup-cancel' &&
          message.params?.type === 'phase' &&
          message.params?.phase === 'running_custom_setup' &&
          message.params?.status === 'started',
      ),
    )
    controlSocket?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: ServerMethods.AGENT_TEAM_SETUP,
        id: 24,
        params: {
          operationId: 'setup-conflict',
          manifestPath: join(cancellableDir, 'agentlet.yaml'),
          harness: 'copilot',
          workingDirPath: cancellableWorkspace,
        },
      }),
    )
    await waitUntil(() =>
      controlMessages.some(
        (message) => 'id' in message && message.id === 24 && 'error' in message,
      ),
    )
    expect(
      controlMessages.find((message) => 'id' in message && message.id === 24),
    ).toMatchObject({
      error: { data: { code: 'workspace_setup_in_progress' } },
    })
    controlSocket?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: ServerMethods.AGENT_TEAM_SETUP_CANCEL,
        id: 23,
        params: { operationId: 'setup-cancel' },
      }),
    )
    await waitUntil(() =>
      controlMessages.some(
        (message) => 'id' in message && message.id === 23 && 'result' in message,
      ),
    )
    expect(
      controlMessages.find((message) => 'id' in message && message.id === 23),
    ).toMatchObject({
      result: { operationId: 'setup-cancel', cancelled: true },
    })
    await waitUntil(() =>
      controlMessages.some(
        (message) =>
          'method' in message &&
          message.method === AgentletMethods.AGENT_TEAM_SETUP_PROGRESS &&
          message.params?.operationId === 'setup-cancel' &&
          message.params?.type === 'cancelled',
      ),
    )
    controlSocket?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: ServerMethods.AGENT_TEAM_VALIDATE,
        id: 25,
        params: {
          manifestPath: join(cancellableDir, 'agentlet.yaml'),
          harness: 'copilot',
          workingDirPath: cancellableWorkspace,
        },
      }),
    )
    await waitUntil(() =>
      controlMessages.some(
        (message) => 'id' in message && message.id === 25 && 'result' in message,
      ),
    )
    expect(
      controlMessages.find((message) => 'id' in message && message.id === 25),
    ).toMatchObject({
      result: {
        valid: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'workspace_not_ready' }),
        ]),
      },
    })

    controlSocket?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: ServerMethods.SPAWN,
        id: 10,
        params: {
          appId: 'thread-a',
          sessionSpec: {
            command: `node ${JSON.stringify(mockAgentPath)}`,
          },
        },
      }),
    )
    await waitUntil(() =>
      controlMessages.some(
        (message) => 'id' in message && message.id === 10 && 'result' in message,
      ),
    )
    const spawnResponse = controlMessages.find(
      (message) => 'id' in message && message.id === 10,
    )
    expect(spawnResponse).toMatchObject({
      result: { sessionId: 'native-bootstrap', pid: expect.any(Number) },
    })
    expect(sessionSocket).toBeUndefined()

    await waitUntil(() => sessionHello !== undefined)
    expect(controlHello).toMatchObject({
      agentletId: 'machine-a',
      agentletProfile: { machine: { hostname: 'machine-a' } },
    })
    expect(sessionHello).toMatchObject({
      sessionId: 'native-bootstrap',
      sessionProfile: {
        agentletId: 'machine-a',
        machine: { hostname: 'machine-a' },
      },
    })
    await waitUntil(() =>
      sessionMessages.some(
        (message) =>
          'method' in message && message.method === 'session/update',
      ),
    )

    controlSocket?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: ServerMethods.STOP,
        id: 11,
        params: { sessionId: 'native-bootstrap' },
      }),
    )
    await waitUntil(() =>
      controlMessages.some(
        (message) => 'id' in message && message.id === 11 && 'result' in message,
      ),
    )
  }, 15_000)
})
