# Host App Integration Guide

> How to embed `@agentlet/server` in a production host application.

## 1. Introduction

This guide is for host-app developers who embed `AgentletServer` as a library and need to go beyond the "hello world" pattern shown in [README §5.3](../README.md#53-embedded-mode-library-api).

**Assumptions:**

- **Passive-host mode** — the agentlet daemon is launched externally (by the user, a process manager, or infrastructure automation). The host does not fork or supervise the daemon process.
- **Token pre-configured** — the authentication token is provisioned out-of-band (environment variable, config file, admin UI). The host validates it on connection.
- **One daemon, N sessions** — the daemon connects once and the host spawns individual agent sessions on-demand via `spawnOnAgentlet()`.

**What this adds over README §5.14:**

| README §5.14 | This guide |
|---|---|
| Assumes agent is already connected | Handles daemon arrival, disappearance, and reconnection |
| One agent = one session | Thread-to-session mapping with per-thread isolation |
| Raw `agent.send()` / `agent.onMessage()` | ACP SDK wrapper with capability handlers |
| No persistence | Session recovery after host restart |
| No concurrency guards | In-flight coalescing, stale-entry eviction |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Host App (Fastify / Express / plain http)                   │
│                                                              │
│  ┌────────────────┐    ┌─────────────────────────────────┐   │
│  │  Mount Layer   │    │  REST / SSE Route Layer          │   │
│  │  (singleton    │    │  POST /threads/:id/prompt        │   │
│  │   AgentletServer)   │  POST /threads/:id/session       │   │
│  └───────┬────────┘    │  GET  /threads/:id/commands      │   │
│          │             └──────────────┬──────────────────┘   │
│  ┌───────▼────────┐                  │                       │
│  │ AgentletServer │    ┌─────────────▼───────────────────┐   │
│  │ (WS upgrade    │    │  Spawn Orchestrator              │   │
│  │  + DataStore   │    │  threadId → sessionId cache      │   │
│  │  + EventStore) │    └─────────────┬───────────────────┘   │
│  └───────┬────────┘                  │                       │
│          │             ┌─────────────▼───────────────────┐   │
│  ┌───────▼────────┐   │  ACP Client Wrapper              │   │
│  │ AgentConnection │◄──┤  (ClientSideConnection + SDK)    │   │
│  │ (per session)  │   │  capability handlers             │   │
│  └────────────────┘   └──────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
         ▲  WebSocket
         │
  agentlet daemon (user-managed, possibly remote)
```

**Four responsibilities of the host:**

1. **Mount** — embed `AgentletServer`, accept WS upgrades, authenticate
2. **Orchestrate** — map application threads to agentlet sessions, spawn on demand
3. **Communicate** — drive ACP protocol via SDK, handle capabilities
4. **Persist** — recover sessions after restart, cache metadata

---

## 3. Mounting the Server

### Singleton pattern

Create exactly one `AgentletServer` instance per process. Make the mount function idempotent so it can be called from multiple plugin registrations without side effects.

```ts
import { AgentletServer } from '@agentlet/server'
import type { AgentletServerOptions } from '@agentlet/protocol'

const UPGRADE_PATH = '/api/acp/agent'
let instance: AgentletServer | null = null

export function mountAgentletServer(httpServer, opts?: {
  storeDir?: string
  authenticate?: AgentletServerOptions['authenticate']
}): AgentletServer {
  if (instance) return instance

  const server = new AgentletServer({
    storeDir: opts?.storeDir ?? './data/agentlet',
    authenticate: opts?.authenticate ?? defaultTokenAuth,
    onConnection: (agent) => {
      console.log(`[agentlet] connected: ${agent.sessionId} (role=${agent.role})`)
    },
    onReconnection: (agent) => {
      console.log(`[agentlet] reconnected: ${agent.sessionId}`)
    },
    onDisconnection: (agent, reason) => {
      console.log(`[agentlet] disconnected: ${agent.sessionId} — ${reason}`)
    },
  })

  instance = server
  return server
}
```

### Timing: initialize after the HTTP server is bound

The server's `init()` must complete before accepting connections. Attach the `upgrade` listener only after the HTTP server has a bound port.

```ts
// Fastify example
app.addHook('onReady', async () => {
  await server.init()
  app.server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith(UPGRADE_PATH)) {
      server.handleUpgrade(req, socket, head)
    }
  })
})

// Express example
httpServer.listen(3001, async () => {
  await server.init()
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith(UPGRADE_PATH)) {
      server.handleUpgrade(req, socket, head)
    }
  })
})
```

> ⚠️ Do NOT call `server.init()` at import time or before `listen()`. The `storeDir` may not exist yet, and you need the bound port for status reporting.

### Authentication

The `authenticate` callback validates the token carried in the daemon's `agentlet/hello` handshake. For passive-host mode, use a pre-shared token:

```ts
async function defaultTokenAuth(token: string, meta: unknown) {
  const validTokens = loadTokensFromConfig()  // e.g., from env or JSON file
  const record = validTokens[token]
  if (!record) throw new Error('Invalid token')
  if (record.expireTime && Date.now() / 1000 > record.expireTime) {
    throw new Error('Token expired')
  }
  return { metadata: { userId: record.user } }
}
```

### Graceful shutdown

```ts
app.addHook('onClose', async () => {
  await server.close()  // sends server/shutdown to all connected agents
  instance = null
})
```

---

## 4. Spawn Orchestration

The orchestrator bridges your application's conversation model (threads, chats, sessions) to agentlet's agent-process model. Each application thread gets its **own** CLI process — never share processes across threads.

### Why per-thread isolation?

Agent CLIs maintain internal state: conversation history, active model, mode, tool approvals. Sharing a process across threads would cause state bleed (one thread's context appearing in another's responses).

### Core interface

```ts
interface SpawnRecipe {
  command: string      // e.g., "claude" or "copilot-cli"
  cwd: string          // working directory for the agent process
  autoRestart?: boolean
}

interface CachedAgent {
  sessionId: string
  pid: number
  agentletId: string   // which daemon instance owns this
}

const threadToAgent = new Map<string, CachedAgent>()
let activeAgentletId: string | null = null
```

### Resolving the active agentlet

The host may only have one connected daemon at a time. Detect when it reconnects with a new identity and invalidate the entire cache:

```ts
function resolveActiveAgentlet(server: AgentletServer): { agentletId: string } | null {
  const live = server.getAgentlets()
  const agentlet = live[0]
  if (!agentlet) return null

  const id = agentlet.sessionId
  if (activeAgentletId && activeAgentletId !== id) {
    // Daemon was replaced — all prior agents are dead
    threadToAgent.clear()
  }
  activeAgentletId = id
  return { agentletId: id }
}
```

### Spawning with cold-start tolerance

```ts
const READY_TIMEOUT_MS = 20_000   // wait for daemon to appear
const CONNECT_TIMEOUT_MS = 3_000  // wait for spawned agent to handshake

export async function ensureAgentForThread(
  threadId: string,
  recipe: SpawnRecipe,
  existingSessionId?: string,
): Promise<{ sessionId: string; pid: number }> {
  // 1. Wait for a connected agentlet
  const agentlet = await waitForActiveAgentlet(READY_TIMEOUT_MS)
  if (!agentlet) {
    throw new Error('Agent worker is not online. Ensure the agentlet daemon is running.')
  }

  // 2. Return cached if still connected
  const cached = threadToAgent.get(threadId)
  if (cached && cached.agentletId === agentlet.agentletId) {
    const conn = server.getConnection(cached.sessionId)
    if (conn?.status === 'connected') {
      return { sessionId: cached.sessionId, pid: cached.pid }
    }
    threadToAgent.delete(threadId)  // stale
  }

  // 3. Spawn a new agent process on the daemon
  const { sessionId, pid } = await server.spawnOnAgentlet(agentlet.agentletId, {
    appId: threadId,
    ...(existingSessionId ? { sessionId: existingSessionId } : {}),
    sessionSpec: {
      command: recipe.command,
      cwd: recipe.cwd,
      autoRestart: recipe.autoRestart,
      idleTimeoutSecs: 600,
    },
  })

  // 4. Wait for the agent's WS handshake to complete
  await waitForAgentConnection(sessionId, CONNECT_TIMEOUT_MS)

  // 5. Cache the mapping
  threadToAgent.set(threadId, { sessionId, pid, agentletId: agentlet.agentletId })
  return { sessionId, pid }
}
```

### Releasing a thread

When a thread is deleted, best-effort stop the agent:

```ts
export async function releaseThread(threadId: string): Promise<void> {
  const cached = threadToAgent.get(threadId)
  threadToAgent.delete(threadId)
  if (!cached) return
  try {
    await server.stopOnAgentlet(cached.agentletId, { sessionId: cached.sessionId })
  } catch {
    // Best-effort — daemon may already be gone
  }
}
```

### Idle timeout & resume

Do **not** eagerly destroy sessions. Configure `idleTimeoutSecs` (default 600s) and let the daemon auto-suspend idle agents. On the next message for that thread, `spawnOnAgentlet` with the `existingSessionId` triggers a transparent `session/load` (or falls back to `session/new` if the agent has forgotten the session).

---

## 5. Session Lifecycle (Skip Redundant Handshake)

### The problem with naive `initialize` + `session/new`

The agentlet daemon already performs the full ACP handshake when it spawns an agent process:

```
daemon spawns agent → initialize → session/new → agent/hello (with sessionId)
```

If the host then sends its own `initialize` + `session/new`, you get:

- **Two sessionIds** for the same agent — the daemon's (which the relay is keyed on) and the host's (which the agent uses internally). Messages route to the wrong session.
- **Wasted round-trips** — the handshake is already done.

### Solution: seed from DataStore

The server persists the daemon's bootstrap result in its DataStore. Read it instead of re-handshaking:

```ts
const dataStore = server.getDataStore()
const record = dataStore.getSession(sessionId)

if (record?.initializeResult) {
  // Seed the client with agent capabilities — no need for initialize RPC
  client.seedFromRecord(record.initializeResult)
}
```

### Replay missed EventStore notifications

Between the daemon's `session/new` and the host constructing its client, the agent may have already pushed `session/update` notifications (modes, models, config options, slash commands). Replay them:

```ts
function replayEventStoreMeta(server, sessionId, entry) {
  const eventStore = server.getEventStore()
  const events = eventStore.getEventsSince(sessionId, 0)

  for (const ev of events) {
    if (ev.dir !== 'agent') continue
    const msg = ev.event as { method?: string; params?: unknown }
    if (msg.method === 'session/update') {
      handleMetaUpdate(entry, msg.params)
    }
  }
}
```

This ensures the host's session state is consistent even though it "missed" the bootstrap notifications.

---

## 6. ACP Client Wrapper

### Why raw `agent.send()` / `agent.onMessage()` isn't enough

The README §5.14 pattern has several problems at scale:

- No request/response correlation (you'd manually match JSON-RPC `id` fields)
- No schema validation of incoming messages
- No capability handler dispatch (`fs/read_text_file`, `session/request_permission`)
- No session listener lifecycle management

### Using `@agentclientprotocol/sdk`

Wrap each `AgentConnection` with the SDK's `ClientSideConnection`. The SDK uses a `Stream` interface (`{ readable, writable }` of `ReadableStream`/`WritableStream`) as its transport — adapt the agentlet connection to this shape:

```ts
import {
  ClientSideConnection,
  type Stream,
  type AnyMessage,
  type Client as SdkClient,
  type Agent as SdkAgent,
} from '@agentclientprotocol/sdk'

// Adapt AgentConnection to the SDK's Stream interface
function streamFromAgentConnection(conn: AgentConnection): {
  stream: Stream
  close: () => void
} {
  let controller: ReadableStreamDefaultController<AnyMessage> | null = null
  let closed = false

  const readable = new ReadableStream<AnyMessage>({
    start(c) {
      controller = c
      conn.onMessage((msg) => {
        if (!closed) {
          try { controller?.enqueue(msg as unknown as AnyMessage) } catch {}
        }
      })
    },
  })
  const writable = new WritableStream<AnyMessage>({
    write(msg) {
      if (!closed) conn.send(msg as unknown as AcpMessage)
    },
  })

  return {
    stream: { readable, writable },
    close: () => { closed = true; try { controller?.close() } catch {} },
  }
}

export class AcpAgentClient {
  private readonly sdk: ClientSideConnection
  private readonly closeStream: () => void
  private readonly sessionListeners = new Map<string, (update) => void>()
  private _isClosed = false

  constructor(conn: AgentConnection, opts?: { projectRoot?: string }) {
    const { stream, close } = streamFromAgentConnection(conn)
    this.closeStream = close

    // The SDK constructor takes a handler factory and a Stream.
    // The handler factory returns a SdkClient with capability handlers
    // that the SDK calls when the agent makes requests to the host.
    this.sdk = new ClientSideConnection(
      (_agent: SdkAgent): SdkClient => ({
        // session/update notifications — dispatch to registered listeners
        sessionUpdate: async (params) => {
          const listener = this.sessionListeners.get(params.sessionId)
          listener?.(params.update)
        },
        // session/request_permission — auto-allow (or surface to UI)
        requestPermission: async (req) => {
          const option = req.options.find(o => o.kind === 'allow_always')
            ?? req.options[0]
          return { optionId: option.optionId }
        },
        // fs/read_text_file — sandboxed read
        readTextFile: async (req) => {
          const resolved = path.resolve(opts?.projectRoot ?? '.', req.path)
          if (opts?.projectRoot && !resolved.startsWith(opts.projectRoot)) {
            throw new Error('Path escapes sandbox')
          }
          return { content: fs.readFileSync(resolved, 'utf-8') }
        },
        // fs/write_text_file — reject (read-only host)
        writeTextFile: async () => {
          throw new Error('Write not supported')
        },
      }),
      stream,
    )
  }

  get isClosed() { return this._isClosed }

  /** Register a long-lived listener for session/update notifications. */
  registerSessionListener(sessionId: string, handler: (update) => void) {
    this.sessionListeners.set(sessionId, handler)
  }

  /** Send a prompt. Resolves when the agent finishes the turn. */
  async prompt(sessionId: string, text: string, signal?: AbortSignal) {
    return this.sdk.prompt({
      sessionId,
      prompt: [{ type: 'text', text }],
    })
  }

  /** Cancel an in-progress prompt. */
  async cancel(sessionId: string) {
    await this.sdk.cancel({ sessionId })
  }

  shutdown(reason?: string) {
    this._isClosed = true
    this.sessionListeners.clear()
    this.closeStream()
  }
}
```

---

## 7. Concurrency & Stale-Entry Guards

### In-flight promise coalescing

Multiple callers may request the same session simultaneously (e.g., UI warm-up and first user prompt arrive in the same tick). Without coalescing, both would spawn sessions and the second would kill the first:

```ts
const inflight = new Map<string, Promise<SessionEntry>>()

export async function ensureSession(threadId, profileId, scopeId) {
  const key = `${threadId}|${profileId}|${scopeId}`

  const existing = inflight.get(key)
  if (existing) return existing  // piggyback on in-flight work

  const p = doEnsureSession(threadId, profileId, scopeId)
    .finally(() => inflight.delete(key))

  inflight.set(key, p)
  return p
}
```

### Stale-entry eviction rules

Before reusing a cached session entry, check all three staleness conditions:

```ts
let entry = registry.get(threadId)

// Rule 1: binding (profile/recipe) changed → rebuild
if (entry && entry.profileId !== binding.profileId) {
  registry.remove(threadId)
  entry = undefined
}

// Rule 2: scope changed → rebuild (sandbox would leak)
if (entry && entry.scopeId !== scopeId) {
  registry.remove(threadId)
  entry = undefined
}

// Rule 3: client was closed (disconnect, error) → reopen
if (entry && entry.client.isClosed) {
  registry.remove(threadId)
  entry = undefined
}

// If entry survives all checks, reuse it
if (entry) return entry
```

---

## 8. Persistence & Recovery

### What to persist

On disk, keyed by `(scopeId, threadId)`:

```ts
interface PersistedSessionRecord {
  sessionId: string           // ACP session id for resume
  profileId: string           // which spawn recipe was used
  cwd: string                 // working directory
  bindingRecipe: SpawnRecipe  // snapshot of the recipe at creation time
  meta?: SessionMeta          // last-known modes/models/commands/usage
}
```

### Recovery after host restart

On first access of a thread after restart:

1. Read persisted `sessionId`
2. Pass it to `ensureAgentForThread(threadId, recipe, existingSessionId)`
3. The daemon attempts `session/load` (resume) with that id
4. If resume fails (agent was restarted too), falls back to `session/new`
5. The host's own chat history remains the source of truth for what the user sees

### Debounced meta persistence

Session-meta notifications (`usage_update`, `config_option_update`, etc.) arrive in bursts. Debounce writes to avoid thrashing the disk:

```ts
const META_DEBOUNCE_MS = 250
const pendingWrites = new Map<string, NodeJS.Timeout>()

function schedulePersistMeta(scopeId, threadId, entry) {
  const key = `${scopeId}|${threadId}`
  const prior = pendingWrites.get(key)
  if (prior) clearTimeout(prior)

  const timer = setTimeout(() => {
    pendingWrites.delete(key)
    writeSessionRecord(scopeId, threadId, { ...entry, meta: snapshotMeta(entry) })
  }, META_DEBOUNCE_MS)

  timer.unref()  // never block process exit
  pendingWrites.set(key, timer)
}
```

---

## 9. Error Handling & Status Reporting

### Daemon offline

When no agentlet is connected, surface a user-actionable error immediately — do not silently hang:

```ts
if (!agentlet) {
  throw new Error(
    'Agent worker is not online. ' +
    'Ensure the agentlet daemon is running and pointed at this server.'
  )
}
```

### Status endpoint

Expose a simple status check so the UI can show connection state:

```ts
app.get('/api/agent/status', () => {
  const live = server.getAgentlets()
  const agentlet = live[0]
  if (agentlet) {
    return {
      online: true,
      agentletId: agentlet.sessionId,
      connectedAt: agentlet.connectedAt.toISOString(),
    }
  }
  return { online: false }
})
```

### Connection loss mid-prompt

If the `AgentConnection` drops while a prompt is in-flight, the SDK's request promise rejects. Surface this as a stream error event so the UI can show a retry affordance:

```ts
try {
  const result = await client.prompt(sessionId, text, { signal })
} catch (err) {
  if (err.message.includes('disconnected')) {
    yield { type: 'error', message: 'Agent disconnected. Retrying...' }
    // Optionally: invalidate cache, re-spawn, retry
  }
}
```

---

## 10. Complete Example

A minimal but production-ready integration using Fastify:

```ts
import Fastify from 'fastify'
import { AgentletServer } from '@agentlet/server'

// ── 1. Boot ──────────────────────────────────────────────────────

const app = Fastify({ logger: true })
const UPGRADE_PATH = '/api/acp/agent'

const agentletServer = new AgentletServer({
  storeDir: './data/agentlet',
  authenticate: async (token) => {
    if (token !== process.env.AGENTLET_TOKEN) throw new Error('bad token')
    return { metadata: {} }
  },
  onConnection: (agent) => app.log.info({ id: agent.sessionId }, 'agent connected'),
  onDisconnection: (agent, reason) => app.log.info({ id: agent.sessionId, reason }, 'agent disconnected'),
})

// ── 2. Mount ─────────────────────────────────────────────────────

app.addHook('onReady', async () => {
  await agentletServer.init()
  app.server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith(UPGRADE_PATH)) {
      agentletServer.handleUpgrade(req, socket, head)
    }
  })
  app.log.info(`agentlet server mounted at ws://<host>${UPGRADE_PATH}`)
})

app.addHook('onClose', () => agentletServer.close())

// ── 3. Orchestrator (simplified) ─────────────────────────────────

const threadCache = new Map<string, { sessionId: string; agentletId: string }>()
let knownAgentletId: string | null = null

async function getOrSpawnSession(threadId: string, recipe: { command: string; cwd: string }) {
  const agentlets = agentletServer.getAgentlets()
  const agentlet = agentlets[0]
  if (!agentlet) throw new Error('No agent worker online')

  // Invalidate cache on daemon swap
  if (knownAgentletId && knownAgentletId !== agentlet.sessionId) {
    threadCache.clear()
  }
  knownAgentletId = agentlet.sessionId

  // Return cached
  const cached = threadCache.get(threadId)
  if (cached?.agentletId === agentlet.sessionId) {
    const conn = agentletServer.getConnection(cached.sessionId)
    if (conn?.status === 'connected') return cached.sessionId
    threadCache.delete(threadId)
  }

  // Spawn new
  const { sessionId } = await agentletServer.spawnOnAgentlet(agentlet.sessionId, {
    appId: threadId,
    sessionSpec: { command: recipe.command, cwd: recipe.cwd, idleTimeoutSecs: 600 },
  })

  // Wait for agent handshake
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const conn = agentletServer.getConnection(sessionId)
    if (conn?.status === 'connected') break
    await new Promise(r => setTimeout(r, 100))
  }

  threadCache.set(threadId, { sessionId, agentletId: agentlet.sessionId })
  return sessionId
}

// ── 4. Prompt route ──────────────────────────────────────────────

app.post('/api/threads/:threadId/prompt', async (request, reply) => {
  const { threadId } = request.params as { threadId: string }
  const { message, command, cwd } = request.body as {
    message: string
    command: string
    cwd: string
  }

  const sessionId = await getOrSpawnSession(threadId, { command, cwd })
  const conn = agentletServer.getConnection(sessionId)
  if (!conn) throw new Error('Agent not connected')

  // Send prompt (using raw JSON-RPC for brevity — prefer SDK wrapper in production)
  const id = Date.now()
  conn.send({
    jsonrpc: '2.0',
    method: 'session/prompt',
    id,
    params: { sessionId, prompt: [{ type: 'text', text: message }] },
  })

  // Collect response (simplified — production code should use SSE streaming)
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Prompt timeout')), 120_000)
    conn.onMessage((msg: any) => {
      if (msg.id === id && msg.result) {
        clearTimeout(timeout)
        resolve(msg.result)
      }
      if (msg.id === id && msg.error) {
        clearTimeout(timeout)
        reject(new Error(msg.error.message))
      }
    })
  })

  return { threadId, sessionId, result }
})

// ── 5. Status route ──────────────────────────────────────────────

app.get('/api/agent/status', () => {
  const agentlets = agentletServer.getAgentlets()
  const a = agentlets[0]
  return a
    ? { online: true, agentletId: a.sessionId, connectedAt: a.connectedAt }
    : { online: false }
})

// ── 6. Start ─────────────────────────────────────────────────────

app.listen({ port: 3001 }).then(() => {
  console.log('Host app listening on :3001')
  console.log(`Agentlet daemon should connect to: ws://localhost:3001${UPGRADE_PATH}`)
})
```

**To run this example:**

```bash
# Terminal 1: start the host app
AGENTLET_TOKEN=my-secret-token node host-app.js

# Terminal 2: start the agentlet daemon (idle mode — waits for spawn requests)
agentlet daemon --server ws://localhost:3001/api/acp/agent --token my-secret-token --allow-insecure
```

---

## Summary

The key patterns that distinguish a production integration from the README's §5.14 example:

1. **Don't re-handshake** — the daemon already bootstrapped. Seed from DataStore.
2. **One thread = one process** — never share agent state across conversations.
3. **Cache + invalidate** — map threads to sessions, wipe on daemon swap.
4. **Coalesce concurrency** — same key, same promise. No duplicate spawns.
5. **Persist + resume** — survive host restarts via `session/load` fallback.
6. **Use the SDK** — raw JSON-RPC is a footgun at scale.
7. **Surface errors early** — "daemon offline" should be user-actionable, not a silent hang.
