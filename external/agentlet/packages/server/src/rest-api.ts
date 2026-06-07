import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentletServer } from './server.js'
import type { TokenStore, TokenMap } from './token-store.js'
import type { AgentletRecord, SessionRecord } from './data-store.js'
import { tokenSignature } from './data-store.js'
import type { AgentConnection } from '@agentlet/protocol'

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

  // GET /api/agents — list all agent connections (DEPRECATED)
  if (method === 'GET' && path === '/api/agents') {
    const agents = opts.server.getConnections().map(agentToJson)
    json(res, 200, { agents }, deprecationHeaders())
    return true
  }

  // GET /api/agents/:id or DELETE /api/agents/:id (DEPRECATED — :id is sessionId)
  const agentMatch = path.match(/^\/api\/agents\/(.+?)(?:\/ws)?$/)
  if (agentMatch && !path.endsWith('/ws')) {
    const sessionId = decodeURIComponent(agentMatch[1]!)

    if (method === 'GET') {
      const conn = opts.server.getConnection(sessionId)
      if (!conn) {
        json(res, 404, { error: 'Agent not found', sessionId }, deprecationHeaders())
        return true
      }
      json(res, 200, agentToJson(conn), deprecationHeaders())
      return true
    }

    if (method === 'DELETE') {
      const conn = opts.server.getConnection(sessionId)
      if (!conn) {
        json(res, 404, { error: 'Agent not found', sessionId }, deprecationHeaders())
        return true
      }
      conn.disconnect('api_requested')
      json(res, 200, { disconnected: true, sessionId }, deprecationHeaders())
      return true
    }
  }

  // GET /api/sessions — list sessions (filtered by token, optionally by status)
  if (method === 'GET' && path === '/api/sessions') {
    const token = extractBearerToken(req)
    if (!token) { json(res, 401, { error: 'Unauthorized' }); return true }
    if (!opts.tokenStore.validate(token)) { json(res, 401, { error: 'Invalid token' }); return true }

    const dataStore = opts.server.getDataStore()

    const statusFilter = url.searchParams.get('status')
    const owner = tokenSignature(token)
    const sessions = dataStore.findSessionsByOwner(owner)
    const filtered = statusFilter
      ? sessions.filter(s => statusFilter.split(',').includes(s.status))
      : sessions

    json(res, 200, { sessions: filtered.map(s => sessionToJson(s, opts.server)) })
    return true
  }

  // GET /api/sessions/:id — get session info
  const sessionInfoMatch = path.match(/^\/api\/sessions\/([^/]+)$/)
  if (sessionInfoMatch && method === 'GET') {
    const sessionId = decodeURIComponent(sessionInfoMatch[1]!)
    const token = extractBearerToken(req)
    if (!token) { json(res, 401, { error: 'Unauthorized' }); return true }
    if (!opts.tokenStore.validate(token)) { json(res, 401, { error: 'Invalid token' }); return true }

    const dataStore = opts.server.getDataStore()

    const session = dataStore.getSession(sessionId)
    if (!session) { json(res, 404, { error: 'Session not found', sessionId }); return true }
    if (session.owner !== tokenSignature(token)) { json(res, 403, { error: 'Forbidden' }); return true }

    json(res, 200, sessionToJson(session, opts.server))
    return true
  }

  // PATCH /api/sessions/:id — update session display name
  if (sessionInfoMatch && method === 'PATCH') {
    const sessionId = decodeURIComponent(sessionInfoMatch[1]!)
    const token = extractBearerToken(req)
    if (!token) { json(res, 401, { error: 'Unauthorized' }); return true }
    if (!opts.tokenStore.validate(token)) { json(res, 401, { error: 'Invalid token' }); return true }

    const dataStore = opts.server.getDataStore()
    const session = dataStore.getSession(sessionId)
    if (!session) { json(res, 404, { error: 'Session not found', sessionId }); return true }
    if (session.owner !== tokenSignature(token)) { json(res, 403, { error: 'Forbidden' }); return true }

    readBody(req).then((raw) => {
      try {
        const body = JSON.parse(raw)
        const displayName = body?.displayName
        if (typeof displayName !== 'string' || !displayName.trim()) {
          json(res, 400, { error: 'displayName is required and must be a non-empty string' })
          return
        }
        dataStore.updateDisplayName(sessionId, displayName.trim())
        const updated = dataStore.getSession(sessionId)!
        json(res, 200, sessionToJson(updated, opts.server))
      } catch {
        json(res, 400, { error: 'Invalid JSON body' })
      }
    })
    return true
  }

  // GET /api/agentlets — list agentlets (from persistent store + live connection status)
  if (method === 'GET' && path === '/api/agentlets') {
    const token = extractBearerToken(req)
    const dataStore = opts.server.getDataStore()
    const owner = token ? tokenSignature(token) : undefined
    const agentlets = dataStore.getAgentlets(owner).map(record => {
      const conn = opts.server.getConnection(record.agentletId)
      return agentletRecordToJson(record, conn)
    })
    json(res, 200, { agentlets })
    return true
  }

  // GET /api/agentlets/:id — get agentlet info
  const agentletInfoMatch = path.match(/^\/api\/agentlets\/([^/]+)$/)
  if (agentletInfoMatch && method === 'GET') {
    const agentletId = decodeURIComponent(agentletInfoMatch[1]!)
    const dataStore = opts.server.getDataStore()
    const record = dataStore.getAgentlet(agentletId)
    if (!record) { json(res, 404, { error: 'Agentlet not found', agentletId }); return true }
    const conn = opts.server.getConnection(agentletId)
    json(res, 200, agentletRecordToJson(record, conn))
    return true
  }

  // POST /api/agentlets/:id/spawn — spawn an agent session on an agentlet
  const spawnMatch = path.match(/^\/api\/agentlets\/([^/]+)\/spawn$/)
  if (spawnMatch && method === 'POST') {
    const agentletSessionId = decodeURIComponent(spawnMatch[1]!)
    const token = extractBearerToken(req)
    if (!token) { json(res, 401, { error: 'Unauthorized' }); return true }

    const dataStore = opts.server.getDataStore()
    const agentlet = dataStore.getAgentlet(agentletSessionId)
    if (!agentlet) { json(res, 404, { error: 'Agentlet not found', sessionId: agentletSessionId }); return true }
    if (agentlet.owner !== tokenSignature(token)) { json(res, 403, { error: 'Forbidden' }); return true }

    readBody(req).then(async (body) => {
      try {
        const params = JSON.parse(body)
        if (!params.sessionSpec?.command) { json(res, 400, { error: 'Missing required field: sessionSpec.command' }); return }
        const result = await opts.server.spawnOnAgentlet(agentletSessionId, params)
        json(res, 200, result)
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : 'Spawn failed' })
      }
    }).catch(() => { json(res, 400, { error: 'Failed to read request body' }) })
    return true
  }

  // POST /api/agentlets/:id/stop — stop an agent session on an agentlet
  const stopMatch = path.match(/^\/api\/agentlets\/([^/]+)\/stop$/)
  if (stopMatch && method === 'POST') {
    const agentletSessionId = decodeURIComponent(stopMatch[1]!)
    const token = extractBearerToken(req)
    if (!token) { json(res, 401, { error: 'Unauthorized' }); return true }

    const dataStore = opts.server.getDataStore()
    const agentlet = dataStore.getAgentlet(agentletSessionId)
    if (!agentlet) { json(res, 404, { error: 'Agentlet not found', sessionId: agentletSessionId }); return true }
    if (agentlet.owner !== tokenSignature(token)) { json(res, 403, { error: 'Forbidden' }); return true }

    readBody(req).then(async (body) => {
      try {
        const params = JSON.parse(body)
        if (!params.sessionId) { json(res, 400, { error: 'Missing required field: sessionId' }); return }
        const result = await opts.server.stopOnAgentlet(agentletSessionId, params)
        json(res, 200, result)
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : 'Stop failed' })
      }
    }).catch(() => { json(res, 400, { error: 'Failed to read request body' }) })
    return true
  }

  // GET /api/agentlets/:id/sessions — list agent sessions on an agentlet
  const listMatch = path.match(/^\/api\/agentlets\/([^/]+)\/sessions$/)
  if (listMatch && method === 'GET') {
    const agentletSessionId = decodeURIComponent(listMatch[1]!)
    const token = extractBearerToken(req)
    if (!token) { json(res, 401, { error: 'Unauthorized' }); return true }

    const dataStore = opts.server.getDataStore()
    const agentlet = dataStore.getAgentlet(agentletSessionId)
    if (!agentlet) { json(res, 404, { error: 'Agentlet not found', sessionId: agentletSessionId }); return true }
    if (agentlet.owner !== tokenSignature(token)) { json(res, 403, { error: 'Forbidden' }); return true }

    opts.server.listOnAgentlet(agentletSessionId)
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

function agentToJson(agent: AgentConnection) {
  return {
    sessionId: agent.sessionId,
    agentletId: agent.agentletId,
    role: agent.role,
    status: agent.status,
    metadata: agent.metadata,
    connectedAt: agent.connectedAt.toISOString(),
  }
}

function agentletRecordToJson(record: AgentletRecord, conn: AgentConnection | undefined) {
  return {
    agentletId: record.agentletId,
    connected: conn?.status === 'connected',
    machine: record.machine,
    bridge: record.bridge,
    capabilities: record.capabilities,
    registeredAt: record.registeredAt,
    updatedAt: record.updatedAt,
    connectedAt: conn?.connectedAt.toISOString() ?? null,
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(), ...extraHeaders })
  res.end(JSON.stringify(body))
}

function deprecationHeaders(): Record<string, string> {
  return {
    'Deprecation': 'true',
    'Link': '</api/sessions>; rel="successor-version"',
    'X-Deprecation-Notice': 'Agent APIs are deprecated. Use /api/sessions/* instead.',
  }
}

function sessionToJson(session: { sessionId: string; displayName: string; agentletId?: string; command: string; cwd: string; status: string; supportsLoad: boolean; supportsResume: boolean; createdAt: string; suspendedAt?: string; updatedAt: string }, server?: AgentletServer) {
  const conn = server?.getConnection(session.sessionId)
  return {
    sessionId: session.sessionId,
    displayName: session.displayName,
    agentletId: session.agentletId,
    connected: conn?.status === 'connected',
    command: session.command,
    cwd: session.cwd,
    supportsLoad: session.supportsLoad,
    supportsResume: session.supportsResume,
    createdAt: session.createdAt,
    suspendedAt: session.suspendedAt,
    updatedAt: session.updatedAt,
  }
}
