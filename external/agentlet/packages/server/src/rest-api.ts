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

  // GET /api/daemons — list connected daemons (filtered by token)
  if (method === 'GET' && path === '/api/daemons') {
    const token = extractBearerToken(req)
    const filter = token ? { token } : undefined
    const daemons = opts.server.getDaemons(filter).map(daemonToJson)
    json(res, 200, { daemons })
    return true
  }

  // GET /api/daemons/:id — get daemon info
  const daemonInfoMatch = path.match(/^\/api\/daemons\/([^/]+)$/)
  if (daemonInfoMatch && method === 'GET') {
    const daemonId = decodeURIComponent(daemonInfoMatch[1]!)
    const daemon = opts.server.getDaemon(daemonId)
    if (!daemon) { json(res, 404, { error: 'Daemon not found', daemonId }); return true }
    json(res, 200, daemonToJson(daemon))
    return true
  }

  // POST /api/daemons/:id/spawn — spawn an agent on a daemon
  const spawnMatch = path.match(/^\/api\/daemons\/([^/]+)\/spawn$/)
  if (spawnMatch && method === 'POST') {
    const daemonId = decodeURIComponent(spawnMatch[1]!)
    const token = extractBearerToken(req)
    const daemon = opts.server.getDaemon(daemonId)
    if (!daemon) { json(res, 404, { error: 'Daemon not found', daemonId }); return true }
    if (token && daemon.token !== token) { json(res, 403, { error: 'Forbidden' }); return true }

    readBody(req).then(async (body) => {
      try {
        const params = JSON.parse(body)
        if (!params.command) { json(res, 400, { error: 'Missing required field: command' }); return }
        const result = await opts.server.spawnOnDaemon(daemonId, params)
        json(res, 200, result)
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : 'Spawn failed' })
      }
    }).catch(() => { json(res, 400, { error: 'Failed to read request body' }) })
    return true
  }

  // POST /api/daemons/:id/stop — stop an agent on a daemon
  const stopMatch = path.match(/^\/api\/daemons\/([^/]+)\/stop$/)
  if (stopMatch && method === 'POST') {
    const daemonId = decodeURIComponent(stopMatch[1]!)
    const token = extractBearerToken(req)
    const daemon = opts.server.getDaemon(daemonId)
    if (!daemon) { json(res, 404, { error: 'Daemon not found', daemonId }); return true }
    if (token && daemon.token !== token) { json(res, 403, { error: 'Forbidden' }); return true }

    readBody(req).then(async (body) => {
      try {
        const params = JSON.parse(body)
        if (!params.agentId) { json(res, 400, { error: 'Missing required field: agentId' }); return }
        const result = await opts.server.stopOnDaemon(daemonId, params)
        json(res, 200, result)
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : 'Stop failed' })
      }
    }).catch(() => { json(res, 400, { error: 'Failed to read request body' }) })
    return true
  }

  // GET /api/daemons/:id/agents — list agents running on a daemon
  const listMatch = path.match(/^\/api\/daemons\/([^/]+)\/agents$/)
  if (listMatch && method === 'GET') {
    const daemonId = decodeURIComponent(listMatch[1]!)
    const token = extractBearerToken(req)
    const daemon = opts.server.getDaemon(daemonId)
    if (!daemon) { json(res, 404, { error: 'Daemon not found', daemonId }); return true }
    if (token && daemon.token !== token) { json(res, 403, { error: 'Forbidden' }); return true }

    opts.server.listOnDaemon(daemonId)
      .then((result) => json(res, 200, result))
      .catch((err) => json(res, 500, { error: err instanceof Error ? err.message : 'List failed' }))
    return true
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

function agentToJson(agent: { agentId: string; token: string; status: string; agentInfo: { command: string; pid: number; cwd: string }; session?: { sessionId: string; supportsLoad: boolean; initializeResult: unknown }; machine?: { hostname: string; platform: string }; bridge: { name: string; version: string }; capabilities: { autoRestart: boolean; bufferLimit: number }; metadata: Record<string, unknown>; connectedAt: Date }) {
  return {
    agentId: agent.agentId,
    status: agent.status,
    agentInfo: agent.agentInfo,
    session: agent.session ? { sessionId: agent.session.sessionId, supportsLoad: agent.session.supportsLoad } : undefined,
    machine: agent.machine,
    bridge: agent.bridge,
    capabilities: agent.capabilities,
    metadata: agent.metadata,
    connectedAt: agent.connectedAt.toISOString(),
  }
}

function daemonToJson(daemon: { daemonId: string; status: string; machine?: { hostname: string; platform: string }; bridge: { name: string; version: string }; capabilities: { autoRestart: boolean; bufferLimit: number; maxAgents?: number }; metadata: Record<string, unknown>; connectedAt: Date }) {
  return {
    daemonId: daemon.daemonId,
    status: daemon.status,
    machine: daemon.machine,
    bridge: daemon.bridge,
    capabilities: daemon.capabilities,
    metadata: daemon.metadata,
    connectedAt: daemon.connectedAt.toISOString(),
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
