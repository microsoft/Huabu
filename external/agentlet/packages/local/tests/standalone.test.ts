import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import WebSocket from 'ws'
import { AgentletServer } from '../../server/src/server.js'
import { HostWebSocket } from '../../server/src/host-ws.js'
import { AgentWebSocket } from '../../server/src/agent-ws.js'
import { handleRestRequest } from '../../server/src/rest-api.js'
import { TokenStore } from '../../server/src/token-store.js'
import { SessionMap } from '../../server/src/session-map.js'
import { AgentProcess } from '../../local/src/agent-process.js'
import { WsClient } from '../../local/src/ws-client.js'
import { Relay } from '../../local/src/relay.js'
import { Logger } from '../../local/src/logger.js'
import type { AcpMessage, AgentConnection } from '@agentlet/protocol'

describe('M4: Standalone server', { timeout: 30000 }, () => {
  let httpServer: Server
  let agentletServer: AgentletServer
  let hostWs: HostWebSocket
  let agentWs: AgentWebSocket
  let serverUrl: string
  let agent: AgentProcess
  let wsClient: WsClient
  let relay: Relay

  beforeAll(async () => {
    // Setup standalone-style server with all endpoints
    agentletServer = new AgentletServer({
      authenticate: async (token) => {
        if (token !== 'test-token') throw new Error('Invalid token')
        return { metadata: { userId: 'test-user' } }
      },
      onConnection: (agent: AgentConnection) => {
        hostWs.broadcast({
          type: 'connected',
          agentId: agent.agentId,
          agentInfo: agent.agentInfo,
        })
        agent.onMessage((msg) => {
          hostWs.broadcast({ type: 'message', agentId: agent.agentId, message: msg })
          agentWs.broadcastToAgent(agent.agentId, msg)
        })
        agent.onLifecycle((event) => {
          hostWs.broadcast({ type: 'lifecycle', agentId: agent.agentId, event })
        })
      },
      onDisconnection: (agent, reason) => {
        hostWs.broadcast({ type: 'disconnected', agentId: agent.agentId, reason })
        agentWs.handleAgentDisconnected(agent.agentId)
      },
    })

    hostWs = new HostWebSocket(agentletServer)

    const tokenStore = new TokenStore()
    tokenStore.loadFromArg('test-token')
    const sessionMap = new SessionMap()
    agentWs = new AgentWebSocket(agentletServer, sessionMap, tokenStore)

    httpServer = createServer((req, res) => {
      if (handleRestRequest(req, res, { server: agentletServer, tokenStore })) return
      res.writeHead(404).end()
    })

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://localhost`)
      const path = url.pathname

      if (path === '/api/bridge') {
        agentletServer.handleUpgrade(req, socket, head)
      } else if (path === '/api/host') {
        hostWs.handleUpgrade(req, socket, head)
      } else {
        const m = path.match(/^\/agents\/(.+)\/ws$/)
        if (m) {
          agentWs.handleUpgrade(req, socket, head, decodeURIComponent(m[1]!))
        } else {
          socket.write('HTTP/1.1 404\r\n\r\n')
          socket.destroy()
        }
      }
    })

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const addr = httpServer.address() as { port: number }
    serverUrl = `ws://127.0.0.1:${addr.port}`

    // Connect an agent
    const echoScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { agentInfo: { name: 'echo-agent' }, capabilities: {} } }) + '\\n');
          } else if (msg.method === 'session/prompt') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/message', params: { text: 'hello from agent' } }) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { done: true } }) + '\\n');
          }
        } catch {}
      });
    `
    agent = new AgentProcess({
      command: `node -e "${echoScript.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`,
    })
    agent.start()
    await new Promise((r) => setTimeout(r, 200))

    wsClient = new WsClient({
      serverUrl: `${serverUrl}/api/bridge`,
      token: 'test-token',
      agentCommand: 'echo-agent',
      agentPid: agent.pid!,
      agentId: 'test-host:echo-agent:project:m4test01',
      capabilities: { autoRestart: false, bufferLimit: 1000 },
      heartbeatInterval: 0,
      allowInsecure: true,
    })

    await new Promise<void>((resolve, reject) => {
      wsClient.on('handshake_ok', () => resolve())
      wsClient.on('handshake_error', (e) => reject(new Error(e.message)))
      wsClient.connect()
    })

    const logger = new Logger('error')
    relay = new Relay(agent, wsClient, logger)
    relay.start()

    // Let things settle
    await new Promise((r) => setTimeout(r, 100))
  })

  afterAll(async () => {
    relay?.stop()
    wsClient?.close()
    agent?.terminate()
    hostWs?.close()
    agentWs?.close()
    await agentletServer?.close()
    httpServer?.close()
    await new Promise((r) => setTimeout(r, 100))
  })

  it('GET /api/health returns ok', async () => {
    const res = await fetch(`http://127.0.0.1:${(httpServer.address() as { port: number }).port}/api/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.connections).toBe(1)
  })

  it('GET /api/agents lists connected agents', async () => {
    const res = await fetch(`http://127.0.0.1:${(httpServer.address() as { port: number }).port}/api/agents`)
    expect(res.status).toBe(200)
    const body = await res.json() as { agents: Array<{ agentId: string; status: string }> }
    expect(body.agents).toHaveLength(1)
    expect(body.agents[0]!.agentId).toBe('test-host:echo-agent:project:m4test01')
    expect(body.agents[0]!.status).toBe('connected')
  })

  it('GET /api/agents/:id returns specific agent', async () => {
    const port = (httpServer.address() as { port: number }).port
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/${encodeURIComponent('test-host:echo-agent:project:m4test01')}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { agentId: string; metadata: { userId: string } }
    expect(body.agentId).toBe('test-host:echo-agent:project:m4test01')
    expect(body.metadata.userId).toBe('test-user')
  })

  it('GET /api/agents/:id returns 404 for unknown agent', async () => {
    const port = (httpServer.address() as { port: number }).port
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/nonexistent`)
    expect(res.status).toBe(404)
  })

  it('WS /api/host receives envelope messages', async () => {
    const ws = new WebSocket(`${serverUrl}/api/host`)

    const messages: unknown[] = []
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    await new Promise<void>((resolve) => {
      ws.on('open', resolve)
    })

    // Wait for initial "connected" broadcast (sent on host client connect)
    await new Promise((r) => setTimeout(r, 200))

    // Should have received the "connected" notification for the existing agent
    expect(messages.length).toBeGreaterThanOrEqual(1)
    const connected = messages[0] as { type: string; agentId: string }
    expect(connected.type).toBe('connected')
    expect(connected.agentId).toBe('test-host:echo-agent:project:m4test01')

    // Send ACP message via envelope protocol
    ws.send(JSON.stringify({
      type: 'send',
      agentId: 'test-host:echo-agent:project:m4test01',
      message: { jsonrpc: '2.0', method: 'initialize', id: 100, params: { clientInfo: { name: 'host-test' } } },
    }))

    // Wait for response
    await new Promise((r) => setTimeout(r, 300))

    const response = messages.find((m: any) => m.type === 'message' && m.message?.id === 100)
    expect(response).toBeDefined()

    ws.close()
  })

  it('WS /agents/:agentId/ws provides raw ACP relay', async () => {
    const agentId = encodeURIComponent('test-host:echo-agent:project:m4test01')
    const ws = new WebSocket(`${serverUrl}/agents/${agentId}/ws`)

    await new Promise<void>((resolve) => {
      ws.on('open', resolve)
    })

    const messages: unknown[] = []
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    // Send raw ACP initialize
    ws.send(JSON.stringify({
      jsonrpc: '2.0', method: 'initialize', id: 200,
      params: { clientInfo: { name: 'raw-test' } },
    }))

    // Wait for response
    await new Promise((r) => setTimeout(r, 300))

    // Should get raw ACP response (no envelope)
    const response = messages.find((m: any) => m.id === 200)
    expect(response).toBeDefined()
    expect((response as any).result.agentInfo.name).toBe('echo-agent')

    ws.close()
  })

  it('WS /agents/:agentId/ws returns 404 for unknown agent', async () => {
    const closed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${serverUrl}/agents/nonexistent/ws`)
      ws.on('open', () => {
        ws.close()
        resolve(false) // should not open
      })
      ws.on('error', () => resolve(true))
      ws.on('unexpected-response', () => {
        resolve(true)
      })
    })

    expect(closed).toBe(true)
  })
})
