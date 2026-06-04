#!/usr/bin/env node
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentletServer } from './server.js'
import { HostWebSocket } from './host-ws.js'
import { AgentWebSocket } from './agent-ws.js'
import { handleRestRequest } from './rest-api.js'
import { TokenStore } from './token-store.js'

import type { AgentConnection, BridgeHelloParams } from '@agentlet/protocol'

interface StandaloneOptions {
  host: string
  port: number
  token: string
  adminToken: string
  allowInsecure: boolean
  noUi: boolean
}

function parseArgs(args: string[]): StandaloneOptions {
  const opts: StandaloneOptions = {
    host: '0.0.0.0',
    port: 8080,
    token: '',
    adminToken: '',
    allowInsecure: false,
    noUi: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    switch (arg) {
      case '--host':
        opts.host = args[++i] ?? '0.0.0.0'
        break
      case '--port':
        opts.port = parseInt(args[++i] ?? '8080', 10)
        break
      case '--token':
        opts.token = args[++i] ?? ''
        break
      case '--admin-token':
        opts.adminToken = args[++i] ?? ''
        break
      case '--allow-insecure':
        opts.allowInsecure = true
        break
      case '--no-ui':
        opts.noUi = true
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
      default:
        console.error(`Unknown argument: ${arg}`)
        printUsage()
        process.exit(1)
    }
  }

  if (!opts.token) {
    console.error('Error: --token <value|path> is required')
    printUsage()
    process.exit(1)
  }

  return opts
}

function printUsage(): void {
  console.log(`
agentlet-server — Standalone relay server for Agentlet

Usage:
  agentlet-server --token <value|path> [options]

Options:
  --host <addr>         Bind address (default: 0.0.0.0)
  --port <port>         Listen port (default: 8080)
  --token <val|path>    A single token string, or path to a JSON token file (required)
  --admin-token <tok>   Enable admin API with this token (disabled if not set)
  --allow-insecure      Allow ws:// connections (dev only)
  --no-ui               Disable built-in web UI
  -h, --help            Show this help

Token file format:
  { "tok_abc": { "user": "alice", "expireTime": null }, ... }
`)
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function resolveUiDistDir(): string | null {
  // Resolve relative to this file: ../../ui/dist
  const thisDir = fileURLToPath(new URL('.', import.meta.url))
  const candidate = resolve(thisDir, '..', '..', 'ui', 'dist')
  if (existsSync(candidate)) return candidate
  return null
}

function serveStaticUi(url: string, res: import('node:http').ServerResponse): boolean {
  const distDir = resolveUiDistDir()
  if (!distDir) return false

  // Strip query/hash
  let pathname = url.split('?')[0]!.split('#')[0]!

  // Default to index.html for SPA routing
  if (pathname === '/' || !pathname.includes('.')) {
    pathname = '/index.html'
  }

  const filePath = join(distDir, pathname)

  // Prevent path traversal
  if (!filePath.startsWith(distDir)) {
    return false
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // For SPA: non-API routes serve index.html
    const indexPath = join(distDir, 'index.html')
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath)
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(content)
      return true
    }
    return false
  }

  const ext = extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
  const content = readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': contentType })
  res.end(content)
  return true
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  const tokenStore = new TokenStore()
  tokenStore.loadFromArg(opts.token)

  // Create the AgentletServer with token-based auth
  const agentletServer = new AgentletServer({
    authenticate: async (token: string, _meta: BridgeHelloParams) => {
      const entry = tokenStore.validate(token)
      if (!entry) {
        throw new Error('Invalid or expired token')
      }
      return { metadata: { user: entry.user } }
    },
    onConnection: (agent: AgentConnection) => {
      console.log(`[agentlet-server] Agent connected: ${agent.agentId}`)
      hostWs.broadcast({
        type: 'connected',
        agentId: agent.agentId,
        agentInfo: agent.agentInfo,
        machine: agent.machine,
      })
      agent.onMessage((msg) => {
        hostWs.broadcast({ type: 'message', agentId: agent.agentId, message: msg })
        agentWs.broadcastToAgent(agent.agentId, msg)
      })
      agent.onLifecycle((event) => {
        hostWs.broadcast({ type: 'lifecycle', agentId: agent.agentId, event })
      })
    },
    onReconnection: (agent: AgentConnection) => {
      console.log(`[agentlet-server] Agent reconnected: ${agent.agentId}`)
      hostWs.broadcast({
        type: 'connected',
        agentId: agent.agentId,
        agentInfo: agent.agentInfo,
        machine: agent.machine,
      })
      agent.onMessage((msg) => {
        hostWs.broadcast({ type: 'message', agentId: agent.agentId, message: msg })
        agentWs.broadcastToAgent(agent.agentId, msg)
      })
      agent.onLifecycle((event) => {
        hostWs.broadcast({ type: 'lifecycle', agentId: agent.agentId, event })
      })
    },
    onDisconnection: (agent: AgentConnection, reason: string) => {
      console.log(`[agentlet-server] Agent disconnected: ${agent.agentId} — ${reason}`)
      hostWs.broadcast({ type: 'disconnected', agentId: agent.agentId, reason })
      agentWs.handleAgentDisconnected(agent.agentId)
    },
  })

  // Host-side WebSocket (envelope protocol)
  const hostWs = new HostWebSocket(agentletServer)

  // Per-agent raw ACP WebSocket (transparent relay)
  const agentWs = new AgentWebSocket(agentletServer, tokenStore)

  // HTTP server
  const httpServer = createServer((req, res) => {
    // REST API
    if (handleRestRequest(req, res, { server: agentletServer, tokenStore, adminToken: opts.adminToken || undefined })) return

    // Serve static UI files
    if (!opts.noUi) {
      const served = serveStaticUi(req.url ?? '/', res)
      if (served) return
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  // WebSocket upgrade routing
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // Agent-side bridge WebSocket
    if (path === '/api/bridge') {
      agentletServer.handleUpgrade(req, socket, head)
      return
    }

    // Host-side envelope WebSocket
    if (path === '/api/host') {
      hostWs.handleUpgrade(req, socket, head)
      return
    }

    // Per-agent raw ACP WebSocket: /agents/:agentId/ws
    const agentMatch = path.match(/^\/agents\/(.+)\/ws$/)
    if (agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]!)
      agentWs.handleUpgrade(req, socket, head, agentId)
      return
    }

    // Unknown upgrade path
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
  })

  // Start listening
  httpServer.listen(opts.port, opts.host, () => {
    console.log(`[agentlet-server] Listening on ${opts.host}:${opts.port}`)
    console.log(`[agentlet-server] Endpoints:`)
    console.log(`  WS  /api/bridge         — agent-side connections (bridge + daemon)`)
    console.log(`  WS  /api/host           — host-side envelope protocol`)
    console.log(`  WS  /agents/:id/ws      — per-agent raw ACP`)
    console.log(`  GET /api/agents         — list agents (filtered by token)`)
    console.log(`  GET /api/daemons        — list daemons (filtered by token)`)
    console.log(`  POST /api/daemons/:id/spawn  — spawn agent on daemon`)
    console.log(`  POST /api/daemons/:id/stop   — stop agent on daemon`)
    console.log(`  GET /api/daemons/:id/agents  — list agents on daemon`)
    console.log(`  GET /api/health         — health check`)
    if (opts.adminToken) {
      console.log(`  GET /api/admin/tokens   — admin: list tokens`)
      console.log(`  POST /api/admin/tokens  — admin: replace tokens`)
    }
    if (!opts.noUi) {
      console.log(`  GET /                   — Web UI`)
    }
  })

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[agentlet-server] Shutting down...')
    hostWs.close()
    agentWs.close()
    await agentletServer.close()
    httpServer.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
