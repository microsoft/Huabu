import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentletServer } from './server.js'
import type { TokenStore, TokenMap } from './token-store.js'

export interface RestApiOptions {
  server: AgentletServer
  tokenStore: TokenStore
  adminToken?: string
}

/**
 * Handle REST API requests for the standalone server.
 * Returns true if the request was handled, false if not matched.
 */
export function handleRestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RestApiOptions
): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const method = req.method?.toUpperCase() ?? 'GET'
  const path = url.pathname

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return true
  }

  // GET /api/health
  if (method === 'GET' && path === '/api/health') {
    json(res, 200, { status: 'ok', connections: opts.server.connectionCount })
    return true
  }

  // GET /api/agents — filtered by Authorization token
  if (method === 'GET' && path === '/api/agents') {
    const token = extractBearerToken(req)
    const filter = token ? { token } : undefined
    const agents = opts.server.getConnections(filter).map(agentToJson)
    json(res, 200, { agents })
    return true
  }

  // GET /api/agents/:id or DELETE /api/agents/:id
  const agentMatch = path.match(/^\/api\/agents\/(.+?)(?:\/ws)?$/)
  if (agentMatch && !path.endsWith('/ws')) {
    const agentId = decodeURIComponent(agentMatch[1]!)

    if (method === 'GET') {
      const conn = opts.server.getConnection(agentId)
      if (!conn) {
        json(res, 404, { error: 'Agent not found', agentId })
        return true
      }
      json(res, 200, agentToJson(conn))
      return true
    }

    if (method === 'DELETE') {
      const conn = opts.server.getConnection(agentId)
      if (!conn) {
        json(res, 404, { error: 'Agent not found', agentId })
        return true
      }
      conn.disconnect('api_requested')
      json(res, 200, { disconnected: true, agentId })
      return true
    }
  }

  // Admin routes — disabled if no admin token configured
  if (path.startsWith('/api/admin/')) {
    if (!opts.adminToken) {
      json(res, 404, { error: 'Not found' })
      return true
    }
    const authToken = extractBearerToken(req)
    if (authToken !== opts.adminToken) {
      json(res, 401, { error: 'Unauthorized' })
      return true
    }
    return handleAdminRequest(method, path, req, res, opts)
  }

  return false
}

function handleAdminRequest(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  opts: RestApiOptions
): boolean {
  // GET /api/admin/tokens — return full token map
  if (method === 'GET' && path === '/api/admin/tokens') {
    json(res, 200, opts.tokenStore.toJSON())
    return true
  }

  // POST /api/admin/tokens — replace full token map
  if (method === 'POST' && path === '/api/admin/tokens') {
    readBody(req).then((body) => {
      try {
        const map = JSON.parse(body) as TokenMap
        opts.tokenStore.replace(map)
        json(res, 200, { ok: true, count: Object.keys(map).length })
      } catch {
        json(res, 400, { error: 'Invalid JSON body' })
      }
    }).catch(() => {
      json(res, 400, { error: 'Failed to read request body' })
    })
    return true
  }

  json(res, 404, { error: 'Not found' })
  return true
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7)
  }
  return undefined
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function agentToJson(agent: { agentId: string; token: string; status: string; agentInfo: { command: string; pid: number }; machine?: { hostname: string; platform: string }; bridge: { name: string; version: string }; capabilities: { autoRestart: boolean; bufferLimit: number }; metadata: Record<string, unknown>; connectedAt: Date }) {
  return {
    agentId: agent.agentId,
    status: agent.status,
    agentInfo: agent.agentInfo,
    machine: agent.machine,
    bridge: agent.bridge,
    capabilities: agent.capabilities,
    metadata: agent.metadata,
    connectedAt: agent.connectedAt.toISOString(),
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() })
  res.end(JSON.stringify(body))
}
