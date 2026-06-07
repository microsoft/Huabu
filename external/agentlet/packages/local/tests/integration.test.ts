import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentletServer } from '../../server/src/server.js'
import { AgentProcess } from '../../local/src/agent-process.js'
import { WsClient } from '../../local/src/ws-client.js'
import { Relay } from '../../local/src/relay.js'
import { Logger } from '../../local/src/logger.js'
import type { AcpMessage, AgentConnection } from '@agentlet/protocol'

function waitFor<T>(emitter: { on: (event: string, cb: (...args: unknown[]) => void) => void }, event: string, timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeout)
    emitter.on(event, (...args: unknown[]) => {
      clearTimeout(timer)
      resolve(args[0] as T)
    })
  })
}

describe('M1: End-to-end transparent relay', () => {
  let httpServer: Server
  let server: AgentletServer
  let agent: AgentProcess
  let ws: WsClient
  let relay: Relay

  afterEach(async () => {
    relay?.stop()
    ws?.close()
    agent?.terminate()
    await server?.close()
    httpServer?.close()
    // Small delay for cleanup
    await new Promise((r) => setTimeout(r, 100))
  })

  it('relays ACP initialize request/response through the bridge', async () => {
    // 1. Setup server
    let connectedAgent: AgentConnection | undefined

    server = new AgentletServer({
      storeDir: mkdtempSync(join(tmpdir(), 'agentlet-test-')),
      authenticate: async (token, meta) => {
        expect(token).toBe('test-token')
        return { metadata: { test: true } }
      },
      onConnection: (agent) => {
        connectedAgent = agent
      },
    })
    await server.init()

    httpServer = createServer()
    httpServer.on('upgrade', (req, socket, head) => {
      server.handleUpgrade(req, socket, head)
    })

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const addr = httpServer.address() as { port: number }
    const serverUrl = `ws://127.0.0.1:${addr.port}`

    // 2. Spawn a mock agent that echoes JSON-RPC responses
    // The mock agent reads JSON from stdin and responds with a result
    const echoScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            const response = { jsonrpc: '2.0', id: msg.id, result: { agentInfo: { name: 'mock-agent', version: '0.1' }, capabilities: { streaming: true } } };
            process.stdout.write(JSON.stringify(response) + '\\n');
          }
        } catch {}
      });
    `
    agent = new AgentProcess({
      command: `node -e "${echoScript.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`,
    })
    agent.start()

    // Wait for agent to be ready
    await new Promise((r) => setTimeout(r, 200))

    // 3. Connect WsClient
    const logger = new Logger('debug')

    ws = new WsClient({
      serverUrl,
      token: 'test-token',
      sessionId: 'test-session-1',
      role: 'session',
      agent: {
        command: 'mock-agent',
        pid: agent.pid!,
        cwd: process.cwd(),
      },
      capabilities: { autoRestart: false, bufferLimit: 1000 },
      heartbeatInterval: 0,
      allowInsecure: true,
    })

    const handshakePromise = waitFor(ws, 'handshake_ok')
    ws.connect()
    await handshakePromise

    // 4. Verify server registered the connection
    expect(connectedAgent).toBeDefined()
    expect(connectedAgent!.sessionId).toBe('test-session-1')
    expect(connectedAgent!.status).toBe('connected')

    // 5. Start relay
    relay = new Relay(agent, ws, logger)
    relay.start()

    // 6. Host app sends ACP initialize through gateway
    const responsePromise = new Promise<AcpMessage>((resolve) => {
      connectedAgent!.onMessage((msg) => resolve(msg))
    })

    connectedAgent!.send({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 42,
      params: { clientInfo: { name: 'test-app', version: '1.0' } },
    })

    // 7. Verify the response comes back from the agent
    const response = await responsePromise
    expect(response).toHaveProperty('id', 42)
    expect(response).toHaveProperty('result')
    const result = (response as { result: { agentInfo: { name: string } } }).result
    expect(result.agentInfo.name).toBe('mock-agent')
  })

  it('server lists connections and handles disconnect', async () => {
    server = new AgentletServer({
      storeDir: mkdtempSync(join(tmpdir(), 'agentlet-test-')),
      authenticate: async (_token, _meta) => {
        return { metadata: {} }
      },
    })
    await server.init()

    httpServer = createServer()
    httpServer.on('upgrade', (req, socket, head) => {
      server.handleUpgrade(req, socket, head)
    })

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const addr = httpServer.address() as { port: number }

    // Connect a client
    agent = new AgentProcess({ command: 'node -e "setInterval(()=>{},1000)"' })
    agent.start()
    await new Promise((r) => setTimeout(r, 100))

    ws = new WsClient({
      serverUrl: `ws://127.0.0.1:${addr.port}`,
      token: 'tok-1',
      sessionId: 'test-session-2',
      role: 'session',
      agent: {
        command: 'test',
        pid: agent.pid!,
        cwd: process.cwd(),
      },
      capabilities: { autoRestart: false, bufferLimit: 100 },
      heartbeatInterval: 0,
      allowInsecure: true,
    })

    await new Promise<void>((resolve) => {
      ws.on('handshake_ok', () => resolve())
      ws.connect()
    })

    // Verify getConnections
    expect(server.connectionCount).toBe(1)
    const conns = server.getConnections({ status: 'connected' })
    expect(conns).toHaveLength(1)
    expect(conns[0]!.sessionId).toBe('test-session-2')

    // Disconnect
    ws.close()
    await new Promise((r) => setTimeout(r, 100))

    const disconnected = server.getConnections({ status: 'disconnected' })
    expect(disconnected).toHaveLength(1)
  })
})
