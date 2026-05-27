# Agentlet — Specification

> Make your local agents accessible from anywhere, without exposing them to the public internet.

---

## 1. Overview

**ACP agents are local-only, but the world needs them over the network — from machines that cannot be publicly reached.**

[Agent Client Protocol](https://agentclientprotocol.com) (ACP) is rapidly becoming the standard interface for AI agents. Most of the popular agents today (Claude Code, Copilot CLI, Gemini CLI, etc.) implement the ACP server side over stdio — they run as subprocesses and communicate via stdin/stdout. This design is stable, battle-tested, and works across all platforms. However, it has a critical limitation: it assumes the agent (the server) must be on the same machine as the client, because the only transport is stdio. Even for the in-draft WebSocket transport, the agent is still a server that listens for inbound connections, which means it must be on a machine with a public IP or properly configured NAT/firewall. However, many real-world use cases require the agent to run on a developer's local machine (where the code, credentials, and tools are) while being driven by a remote system (cloud-hosted IDE, canvas, orchestrator). This creates a fundamental mismatch: the agent is running in an environment that is not designed to accept inbound connections, yet the demand is for remote access from machines that cannot reach it directly.

This is the same class of problem that `ngrok` solves for HTTP servers, or SSH reverse tunnels solve for arbitrary TCP — **but for ACP agents specifically.** The agent can't be a server; someone needs to bridge it out.

### What Agentlet Does

**Agentlet** is a thin relay process (~500 lines) that upgrades any stdio-only ACP agent into a network-accessible agent. It:

1. Spawns the agent locally via ACP stdio (the only stable transport)
2. Opens an **outbound** WebSocket to a remote server (traversing NAT naturally)
3. Relays ACP JSON-RPC messages bidirectionally — transparently, without interpretation
4. Handles reconnection and buffering so the agent is never disturbed by network issues

It has **zero AI logic**, **zero application knowledge**, and is completely server-agnostic. Any system that accepts an ACP-over-WebSocket connection can use Agentlet as its local-side adapter.

### Why not wait for ACP's native WebSocket transport?

The [Streamable HTTP & WebSocket Transport RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport) is in active development (Working Group formed April 2026), but:

- It may take 6–12+ months to stabilize and for agents to adopt it
- Even when stable, it makes the **agent** a WebSocket server — the NAT/firewall problem remains (the remote system still can't reach a server behind the developer's firewall)
- Agentlet is forward-compatible: once agents expose native WebSocket, Agentlet simply connects locally instead of spawning, and the remote relay stays the same

| Constraint | How Agentlet solves it |
|---|---|
| Agent only speaks stdio | Agentlet spawns it locally and bridges stdio ↔ WebSocket |
| Agent is behind NAT | All connections are **outbound** from the user's machine — no public IP needed |
| Remote system needs push | WebSocket is full-duplex — server can send prompts at any time |
| Network is unreliable | Agentlet buffers and reconnects; agent subprocess is never touched |

---

## 2. Get Started

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9 (for building from source)
- An ACP-compatible agent installed locally (e.g., Claude Code, Copilot CLI, Gemini CLI)

### Quick Start (standalone server + one agent)

**1. Install packages**

```bash
npm install -g agentlet @agentlet/server
```

Since packages are not yet published to npm, install from the git repository:

```bash
git clone https://github.com/anthropics/agentlet.git
cd agentlet
pnpm run source-install
```

After linking, `agentlet` and `agentlet-server` are available as global commands.

**2. Start the server**

```bash
# With inline token (simplest)
agentlet-server --port 8080 --token "tok_dev_123" --allow-insecure
# Multiple tokens via JSON file:
# { "tok_dev_123": { "user": "alice", "expireTime": null }, "tok_dev_456": { "user": "bob", "expireTime": null } }
agentlet-server --port 8080 --token "./tokens.json" --allow-insecure
```

The server is now listening on `http://localhost:8080` with the Web UI, REST API, and WebSocket endpoints.

**3. Connect an agent**

In the agent-side terminal, where you previously ran the agent command (e.g., `copilot --allow-all` or `claude`, etc.), run the `agentlet` CLI to start an agent instance in the current directory and connect it to the server:

```bash
agentlet --agent "copilot --acp --allow-all" \
         --server "ws://localhost:8080/api/bridge" \
         --token "tok_dev_123" \
         --allow-insecure
```

**4. Open the Web UI**

Navigate to `http://localhost:8080` — select the agent from the dropdown and start chatting.

You can also use the headless WebSocket API (e.g., via `@agentlet/client`) or embed `@agentlet/server` directly in your own host application for programmatic access.

---

## 3. Architecture

### Three Components

| Component | Package | Where it runs | Nature |
|---|---|---|---|
| **Agent-side adapter** | `agentlet` | User's machine (next to the agent) | CLI tool (installed by end user) |
| **Relay server** | `@agentlet/server` | Remote server | Library (embedded) or standalone executable |
| **Host-side SDK** | `@agentlet/client` | Inside the host application | Library (imported by host app developers) |
| **Web UI** | `@agentlet/ui` | Browser (served by standalone server) | Built-in first-party host app (Vue 3 SPA) |

```mermaid
graph LR
    subgraph agent_side["Agent Side (behind NAT)"]
        Agent["Agent Process<br/>(ACP Server, stdio)"]
        Adapter["agentlet<br/>(CLI tool)"]
        Agent <-->|"stdin / stdout<br/>(ACP JSON-RPC)"| Adapter
    end

    subgraph server_side["Relay Server"]
        Server["@agentlet/server<br/>(relay + connection registry)"]
    end

    subgraph host_side["Host Side"]
        Client["@agentlet/client<br/>(SDK)"]
        App["Host Application<br/>(IDE, canvas, orchestrator)"]
        Client <-->|"typed API<br/>(events + methods)"| App
    end

    Adapter -->|"outbound WSS<br/>(agent-side WS)"| Server
    Server -->|"WSS frames"| Adapter
    Client -->|"outbound WSS<br/>(host-side WS)"| Server
    Server -->|"WSS frames"| Client
```

### Two modes for the relay server

| Mode | Use case | How |
|---|---|---|
| **Embedded (library)** | Host app runs its own server and wants in-process access | `import { AgentletServer } from '@agentlet/server'` — mount on existing HTTP server |
| **Standalone (executable)** | Quick setup, self-hosted, or when host app is a separate service | `agentlet-server --port 8080 --token tok_abc` — runs its own HTTP server with REST + WS endpoints |

When embedded, the host app imports `@agentlet/server` and interacts with agents directly via TypeScript API (no network hop on the host side — `@agentlet/client` is not needed).

When standalone, the host app connects remotely via `@agentlet/client` SDK, which provides the **same typed API** as the embedded mode.

### Data flow

```
Host Application
    ↕ @agentlet/client (typed API, or direct import of @agentlet/server)
Relay Server — @agentlet/server (manages connections, routes messages)
    ↕ WebSocket (ACP JSON-RPC + bridge/* control messages)
Agent-side adapter — agentlet (transparent relay on user's machine)
    ↕ stdin/stdout (ACP JSON-RPC)
Agent Process (Claude Code / Copilot CLI / etc.)
```

Every message between the relay server and the agent is a **standard ACP JSON-RPC 2.0** message. The agent-side adapter does not interpret, transform, or filter these messages — it is a transparent pipe.

### Host-side WebSocket protocol

When the host app connects to the relay server via `@agentlet/client` (or raw WebSocket), the following envelope protocol is used:

```jsonc
// ─── Host → Server ───────────────────────────────
// Send an ACP message to a specific agent
{ "type": "send", "agentId": "dev-laptop:node:my-project:f47ac10b", "message": { "jsonrpc": "2.0", ... } }

// ─── Server → Host ───────────────────────────────
// ACP message received from an agent
{ "type": "message", "agentId": "dev-laptop:node:my-project:f47ac10b", "message": { "jsonrpc": "2.0", ... } }

// Agent lifecycle event
{ "type": "lifecycle", "agentId": "dev-laptop:node:my-project:f47ac10b", "event": { "type": "agent_exited", ... } }

// Agent came online
{ "type": "connected", "agentId": "dev-laptop:node:my-project:f47ac10b", "agentInfo": { "command": "...", "pid": 12345 } }

// Agent went offline
{ "type": "disconnected", "agentId": "dev-laptop:node:my-project:f47ac10b", "reason": "websocket_closed" }
```

---

## 4. Agent-Side Adapter — `agentlet` CLI

### Agent Identity (`agentId`)

Each agent-side adapter instance generates a globally unique `agentId` on startup:

```
Format:  <hostname>:<executable>:<cwd-basename>:<8-char-uuid>
Example: dev-laptop:node:my-project:f47ac10b
```

| Component | Source | Purpose |
|---|---|---|
| `hostname` | `os.hostname()` | Which machine the agent runs on |
| `executable` | basename of first token in `--agent` | Which agent program (e.g., `node`, `claude`, `python`) |
| `cwd-basename` | basename of `--cwd` (or process.cwd) | Which project/directory context |
| `8-char-uuid` | `crypto.randomUUID().slice(0,8)` | Uniqueness across concurrent instances |

**Lifecycle:** The `agentId` is generated once when the bridge process starts and remains stable for its entire lifetime — surviving WebSocket reconnections and agent restarts (if `--auto-restart` is enabled). It changes only when the bridge process itself restarts.

**Used by:** The relay server uses `agentId` as the primary key for its connection registry. Host apps address agents by `agentId`.

### Core Responsibilities

| # | Responsibility | Details |
|---|---|---|
| 1 | **Spawn agent subprocess** | Start the agent command via child process with stdio pipes. Respect the agent's expected working directory and environment. |
| 2 | **Establish outbound WebSocket** | Connect to the relay server's endpoint using the provided token for authentication. TLS required in production. |
| 3 | **Relay messages bidirectionally** | Forward every complete JSON-RPC message from stdout → WebSocket and from WebSocket → stdin. No buffering beyond message framing. |
| 4 | **Handle reconnection** | On WebSocket disconnect: buffer agent stdout, reconnect with exponential backoff, replay buffered messages on reconnection. Agent subprocess is unaffected. |
| 5 | **Report lifecycle events** | Notify the server of bridge-level events (agent crash, agent exit, bridge shutting down) via bridge-specific control messages. |
| 6 | **Graceful shutdown** | On SIGINT/SIGTERM: send `bridge/goodbye` to server, send SIGTERM to agent, close WebSocket cleanly. |

### Non-responsibilities (explicit)

- ❌ No AI logic — never generates prompts or interprets agent responses.
- ❌ No application knowledge — does not know what the remote system does (canvas, IDE, orchestrator — irrelevant).
- ❌ No message transformation — all ACP messages pass through verbatim.
- ❌ No credential management — does not handle the agent's API keys (those belong to the agent's own environment).
- ❌ No agent configuration — the agent command is passed opaquely; doesn't know or care which agent it is.

---

### CLI Interface

### Installation

```bash
npm install -g agentlet
```

### Usage

```bash
agentlet --agent <command> --server <wss-url> --token <token> [options]
```

### Required arguments

| Argument | Description | Example |
|---|---|---|
| `--agent` | Shell command to spawn the agent. Must support ACP stdio. | `"claude --acp --stdio"` |
| `--server` | Remote server's bridge endpoint (WSS URL). | `"wss://app.example.com/api/bridge"` |
| `--token` | Authentication token identifying this connection to the remote server. | `"tok_abc123..."` |

### Optional arguments

| Argument | Default | Description |
|---|---|---|
| `--cwd` | Current directory | Working directory for the agent subprocess |
| `--reconnect-max` | `300` (5 min) | Maximum reconnection backoff in seconds |
| `--buffer-limit` | `1000` | Max messages buffered during disconnection (oldest dropped on overflow) |
| `--auto-restart` | `false` | Restart agent subprocess if it exits unexpectedly |
| `--restart-delay` | `2000` | Milliseconds to wait before restarting agent |
| `--restart-max` | `5` | Maximum consecutive restart attempts before giving up |
| `--log-level` | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |
| `--log-file` | (none) | Path to write structured log output (JSON lines) |
| `--env` | (none) | Extra environment variables for the agent: `--env KEY=VALUE` (repeatable) |
| `--heartbeat` | `30` | WebSocket ping interval in seconds (0 to disable) |

### Examples

```bash
# Connect Claude Code to a remote server
agentlet --agent "claude --acp --stdio" \
         --server "wss://app.example.com/api/bridge" \
         --token "tok_from_server_ui"

# Connect Copilot CLI with a specific project directory
agentlet --agent "copilot --acp --stdio" \
         --server "wss://localhost:3001/api/bridge" \
         --token "tok_dev_local" \
         --cwd "/home/user/my-project" \
         --auto-restart

# Connect with custom environment for the agent
agentlet --agent "gemini-cli --stdio" \
         --server "wss://app.example.com/api/bridge" \
         --token "tok_xyz" \
         --env "GEMINI_API_KEY=sk-..." \
         --env "PROJECT_ROOT=/workspace"
```

### Agent Subprocess Management

#### Spawning

> **Source:** [`packages/local/src/agent-process.ts`](packages/local/src/agent-process.ts)

- **stdin**: Writable — Agentlet writes ACP messages (from server) here.
- **stdout**: Readable — Agent writes ACP responses here. Agentlet reads and relays.
- **stderr**: Readable — Agent diagnostic output. Logged by Agentlet but **not relayed** to server (it's not ACP protocol traffic).

#### Exit Handling

| Exit type | Action |
|---|---|
| Clean exit (code 0) | Send `bridge/agent_exited` with code 0. Do not restart. |
| Crash (code ≠ 0) | Send `bridge/agent_exited`. If `--auto-restart` enabled, restart after delay (up to `--restart-max`). |
| Signal (SIGTERM, SIGKILL) | Send `bridge/agent_exited` with signal name. Respect `--auto-restart`. |

#### Graceful Shutdown

> **Source:** `Bridge.shutdown()` in [`packages/local/src/bridge.ts`](packages/local/src/bridge.ts)

On SIGINT or SIGTERM to Agentlet:

1. Send `bridge/goodbye` to server.
2. Close stdin to agent (signals EOF → agent should exit).
3. Wait up to 5 seconds for agent to exit.
4. If agent still alive, send SIGTERM.
5. Wait 2 more seconds, then SIGKILL if necessary.
6. Close WebSocket.
7. Exit with code 0.

---

## 5. Relay Server — `@agentlet/server`

### Overview

`@agentlet/server` is a lightweight TypeScript package that manages agent connections over WebSocket. It can be used in two ways:

1. **Embedded library** — import into your own server for in-process access to agents
2. **Standalone executable** — run independently, exposing REST + WebSocket APIs for host apps to connect remotely

The relay server is where **multiplexing** happens — a single instance manages connections from many agents simultaneously.

### Installation

```bash
npm install @agentlet/server
```

### Embedded Mode (Library API)

```ts
import { AgentletServer, type AgentConnection } from '@agentlet/server'

const server = new AgentletServer({
  authenticate: async (token, meta) => {
    const record = await db.findToken(token)
    if (!record || record.expired) throw new Error('Invalid token')
    return { metadata: { userId: record.userId } }
  },
  onConnection: (agent) => console.log(`Agent connected: ${agent.agentId}`),
  onReconnection: (agent) => console.log(`Agent reconnected: ${agent.agentId}`),
  onDisconnection: (agent, reason) => console.log(`Agent disconnected: ${agent.agentId} — ${reason}`),
})

// Mount on your HTTP server (works with any framework)
httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/api/bridge') {
    server.handleUpgrade(req, socket, head)
  }
})

// Graceful shutdown
process.on('SIGTERM', async () => {
  await server.close()
  process.exit(0)
})
```

> See **§6.6 Protocol Type Reference** for full `AgentletServerOptions` and `AgentConnection` definitions.

### Standalone Mode (CLI)

```bash
agentlet-server --port 8080 --token "tok_abc"
```

| Argument | Default | Description |
|---|---|---|
| `--host` | `0.0.0.0` | Bind address |
| `--port` | `8080` | Listen port |
| `--token <value\|path>` | (required) | A single token string, or path to a JSON token file (see format below) |
| `--admin-token <token>` | (disabled) | Enable admin API with this token. If not set, admin routes are disabled. |
| `--allow-insecure` | `false` | Allow ws:// (non-TLS) for local development |
| `--no-ui` | `false` | Disable the built-in web UI (headless mode) |

**Token file format:**

```json
{
  "tok_alice_123": { "user": "alice", "expireTime": null },
  "tok_bob_456": { "user": "bob", "expireTime": 1735689600 }
}
```

Each key is a token string. `expireTime` is a Unix timestamp (seconds) or `null` for no expiry.

When running standalone, the server exposes:
- `WS /api/bridge` — agent-side WebSocket (agentlet CLI connects here)
- `WS /api/host` — host-side WebSocket (host app connects here via `@agentlet/client`)
- `WS /agents/:agentId/ws?token=<tok>` — per-agent raw ACP WebSocket (token-authenticated)
- `GET /api/agents` — REST: list connected agents (filtered by `Authorization: Bearer <token>`)
- `GET /api/agents/:id` — REST: get agent info
- `DELETE /api/agents/:id` — REST: disconnect an agent
- `GET /api/health` — REST: health check
- `GET /api/admin/tokens` — Admin: list all tokens (requires `--admin-token`)
- `POST /api/admin/tokens` — Admin: replace full token map (requires `--admin-token`)

### `AgentletServer` instance methods

> **Source:** [`packages/server/src/server.ts`](packages/server/src/server.ts)

Key methods: `handleUpgrade()`, `getConnection(agentId)`, `getConnections(filter?)`, `connectionCount`, `close()`.

> **Library design notes:**
> - Multiple `AgentletServer` instances in a single process are supported (no global state, no singletons).
> - In embedded mode, the server never calls `listen()` — it only accepts already-upgraded sockets.
> - Importing the package has zero side effects.
> - Call `server.close()` during shutdown to ensure all agents receive `bridge/shutdown`.

> For full type definitions of `AgentletServerOptions`, `AuthResult`, `AgentConnection`, and `BridgeLifecycleEvent`, see **§6.6 Protocol Type Reference**.

### Connection Registry & Reconnection

The relay server maintains an internal registry: `Map<agentId, AgentConnection>`. The `agentId` is the stable identity (see §4 "Agent Identity"). See **§6.5 Reconnection Protocol** for the full reconnection flow.

### Core Responsibilities

| # | Responsibility | Details |
|---|---|---|
| 1 | **Agent-side WebSocket endpoint** | Accept incoming WSS connections from agent-side adapters (`agentlet` CLI). |
| 2 | **Host-side WebSocket endpoint** | Accept incoming WSS connections from host apps (standalone mode) or provide in-process API (embedded mode). |
| 3 | **Token validation** | Delegate to `authenticate` callback (embedded) or static token file (standalone). Reject invalid/expired tokens. |
| 4 | **Connection registry** | Track all active agent connections. Provide lookup by agentId. |
| 5 | **Message routing** | Forward ACP messages from host → correct agent, and from agent → host. |
| 6 | **Reconnection handling** | Recognize reconnecting agents (same agentId), restore connection state, replay buffered messages. |
| 7 | **Lifecycle events** | Surface `bridge/agent_exited`, `bridge/goodbye`, etc. to host via typed events. |

### Non-responsibilities

- ❌ No AI logic — never generates prompts or interprets agent responses.
- ❌ No token generation — host app generates and manages tokens. Server only validates.
- ❌ No persistence — connection and session state is in-memory. If the server restarts, agents reconnect automatically and new sessions are created.

### Web UI (Standalone Mode)

When running in standalone mode, `agentlet-server` serves a built-in web interface at the root path (`/`). This provides a **first-party host application** for interactive use — chatting with agents, monitoring traffic, and managing connections — without requiring a separate host app.

#### Per-Agent Raw ACP WebSocket Endpoint

To support standard ACP-compatible UIs, the standalone server exposes a **raw ACP WebSocket** per connected agent:

```
WS /agents/:agentId/ws
```

This endpoint speaks **raw ACP JSON-RPC** — no envelope protocol. Each WebSocket frame is a single ACP JSON-RPC message, identical to how standard ACP clients expect to communicate. The server transparently bridges between this raw endpoint and the internal agent connection.

This means:

- The built-in UI connects via standard ACP WebSocket transport (no custom protocol)
- Any external ACP-compatible UI (e.g., [acp-ui](https://github.com/formulahendry/acp-ui)) can also connect to individual agents
- The envelope-based `/api/host` endpoint remains available for multi-agent programmatic access via `@agentlet/client`

#### Data Flow (UI → Agent)

```
Browser (Web UI)
    ↕ Raw ACP JSON-RPC over WebSocket (/agents/:agentId/ws)
agentlet-server (standalone)
    ↕ Internal bridge protocol (already connected)
agentlet (agent-side adapter)
    ↕ stdin/stdout (ACP JSON-RPC)
Agent Process
```

The per-agent endpoint is essentially a **transparent ACP proxy**: the server strips/adds internal routing but from the UI's perspective it's talking directly to an ACP agent.

#### UI Features

| Feature | Description |
|---|---|
| **Chat** | Send prompts, receive streaming responses, view agent messages |
| **Multi-agent** | Agent selector — switch between connected agents (discovered via REST API) |
| **Permissions** | Approve/deny agent permission requests (tool calls, file access) |
| **Traffic monitor** | Inspect raw ACP JSON-RPC messages in real time |
| **Sessions** | Create, resume, and manage ACP sessions per agent |
| **Connection status** | Live indicator for agent online/offline/reconnecting state |

#### Technology Stack

The UI is a Vue 3 single-page application (SPA) built with Vite, bundled as static assets:

- **Framework:** Vue 3 + TypeScript + Pinia (state management)
- **Build:** Vite → static `dist/` directory
- **Transport:** Standard ACP WebSocket transport (connects to `/agents/:agentId/ws`)
- **Agent discovery:** `GET /api/agents` REST endpoint (no local config file needed)
- **Packaging:** Pre-built assets included in `@agentlet/server` package, served at `/` in standalone mode

#### Updated Standalone Endpoints

Full endpoint list when running standalone (supersedes the table above):

| Endpoint | Purpose |
|---|---|
| `GET /` | Web UI (static SPA) |
| `WS /api/bridge` | Agent-side WebSocket (agentlet CLI connects here) |
| `WS /api/host` | Host-side WebSocket — envelope protocol (programmatic multi-agent access) |
| `WS /agents/:agentId/ws?token=<tok>` | Per-agent raw ACP WebSocket — token-authenticated, with session tracking |
| `GET /api/agents` | REST: list connected agents (filtered by `Authorization: Bearer <token>`) |
| `GET /api/agents/:id` | REST: get agent info |
| `DELETE /api/agents/:id` | REST: disconnect an agent |
| `GET /api/health` | REST: health check |
| `GET /api/admin/tokens` | Admin: list tokens (gated by `--admin-token`) |
| `POST /api/admin/tokens` | Admin: replace full token map (gated by `--admin-token`) |

#### Reference: acp-ui

The UI design is adapted from [acp-ui](https://github.com/formulahendry/acp-ui) (MIT licensed, Vue 3 + Vite). Key adaptations from acp-ui:

| acp-ui (original) | agentlet UI (adapted) |
|---|---|
| Tauri desktop app + web build | Web-only (served by `agentlet-server`) |
| Agent config via local JSON file | Agent discovery via `GET /api/agents` |
| Connects to agent URL directly | Connects via `/agents/:agentId/ws` (server proxies) |
| Supports stdio + WebSocket transport | WebSocket only (agents are always remote via agentlet) |
| Single-agent per connection | Multi-agent (selector UI with all connected agents) |

---

### Admin Control Plane

When `--admin-token` is set, the server exposes admin routes for token management:

```bash
agentlet-server --port 8080 --token "./tokens.json" --admin-token "admin_secret_xyz"
```

#### Admin API

All admin requests require `Authorization: Bearer <admin-token>` header.

**`GET /api/admin/tokens`** — Returns the current full token map:

```json
{
  "tok_alice_123": { "user": "alice", "expireTime": null },
  "tok_bob_456": { "user": "bob", "expireTime": 1735689600 }
}
```

**`POST /api/admin/tokens`** — Atomically replaces the entire token map:

```bash
curl -X POST http://localhost:8080/api/admin/tokens \
  -H "Authorization: Bearer admin_secret_xyz" \
  -H "Content-Type: application/json" \
  -d '{"tok_new": {"user": "charlie", "expireTime": null}}'
```

This is a full-map swap (not per-token CRUD) — designed for POC simplicity. For any token changes, modify your local file and POST the entire file content.

#### Multi-User Flow

Each token represents a user. The token is used for:
1. **Agent bridge authentication** — `agentlet --token <tok>` identifies which user owns this agent
2. **REST API filtering** — `GET /api/agents` with `Authorization: Bearer <tok>` returns only that user's agents
3. **WebSocket authentication** — `/agents/:agentId/ws?token=<tok>` validates access
4. **UI login** — user enters their token in the web UI to see only their agents

---

### Session Reconnection

The server provides **transparent session reconnection** using ACP's `session/load` protocol. This is entirely server-managed — the UI always sends `session/new`, and the server handles the rest.

#### How It Works

```
UI connects → sends session/new → server checks session map
                                         │
                              ┌───────────┴───────────┐
                              No stored session         Has stored sessionId
                              │                        │
                              ▼                        ▼
                         Pass through              Rewrite to session/load
                         session/new                {sessionId: stored}
                              │                        │
                              ▼                        ▼
                         Agent responds            Agent replays history
                         {sessionId: new}           via session/update
                              │                        │
                              ▼                        ▼
                         Server stores             UI gets full history
                         sessionId in map          transparently
```

#### Session Map

The server maintains an in-memory `SessionMap`: `(token, agentId) → sessionId`

- **On first `session/new`**: server passes through, captures the sessionId from the response, stores in map
- **On reconnect**: UI sends `session/new` again, server finds stored sessionId, rewrites to `session/load`
- **On error**: if `session/load` fails (session expired), server clears the stored sessionId → next attempt creates a fresh session
- **Scope**: per-user, per-agent. Each user has their own session with each agent.

#### Relay CWD Injection

The agentlet-local relay intercepts both `session/new` and `session/load` to inject the real local working directory (`process.cwd()`). The remote UI doesn't know or control where the agent runs — the relay is the local authority.

---

### Framework Integration Examples (Embedded Mode)

```ts
// Express
const app = express()
const httpServer = app.listen(3001)
httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/api/bridge') server.handleUpgrade(req, socket, head)
})

// Fastify
fastify.server.on('upgrade', (req, socket, head) => {
  if (req.url === '/api/bridge') server.handleUpgrade(req, socket, head)
})

// Plain Node.js http
const httpServer = http.createServer()
httpServer.on('upgrade', (req, socket, head) => {
  server.handleUpgrade(req, socket, head)
})
httpServer.listen(3001)
```

### Host App Usage Pattern (Embedded Mode)

```ts
// When user triggers an action that requires the agent:
const agent = server.getConnection('dev-laptop:node:my-project:f47ac10b')
if (!agent || agent.status !== 'connected') {
  throw new Error('Agent is offline')
}

// Send ACP initialize (if not already done)
agent.send({
  jsonrpc: '2.0', method: 'initialize', id: 1,
  params: { clientInfo: { name: 'my-app', version: '1.0' } }
})

// Listen for responses
agent.onMessage((msg) => {
  if (msg.id === 1) {
    // Initialize response — agent is ready
    console.log('Agent capabilities:', msg.result)
  }
  if (msg.method === 'session/message') {
    // Streaming content from agent
    renderToUI(msg.params.message)
  }
})
```

---

## 6. Protocol

### 5.1 Connection Establishment

The connection has two phases: the **bridge handshake** (agent-side adapter ↔ server) and then transparent **ACP relay** (host app ↔ agent, flowing through the bridge).

```mermaid
sequenceDiagram
    participant Agent as Agent Process
    participant Local as agentlet (agent-side)
    participant GW as @agentlet/server
    participant App as Host Application

    Note over Local: Spawns agent subprocess
    Local->>Agent: spawn(command, stdio)
    Agent-->>Local: (process started, pid)

    Note over Local,GW: Phase 1 — Bridge Handshake
    Local->>GW: WebSocket open (outbound WSS)
    Local->>GW: bridge/hello {token, agentId, bridge, agent, capabilities}
    GW->>App: authenticate(token, meta)
    App-->>GW: {metadata}
    GW->>App: onConnection(agent)
    GW-->>Local: hello response {agentId, status}

    Note over Local,GW: Phase 2 — Transparent ACP Relay
    App->>GW: agent.send(initialize)
    GW->>Local: initialize (WS frame)
    Local->>Agent: initialize + \n (stdin)
    Agent-->>Local: init response (stdout)
    Local-->>GW: init response (WS frame)
    GW->>App: onMessage(init response)

    Note over Local,GW: All subsequent ACP traffic flows<br/>transparently in both directions
```

**Identity model:** Each agent is uniquely identified by its `agentId`, generated by the agent-side adapter in the format `<hostname>:<executable>:<cwd-basename>:<8-char-uuid>`. This ID is stable for the lifetime of the bridge process — surviving WebSocket reconnections — and changes only when the bridge process restarts. The server uses `agentId` as the primary key. The `authenticate()` callback only validates the token and returns optional metadata; it does not assign identity.

### 5.2 Bridge Handshake Messages

Upon connecting, the agent-side adapter sends a single `bridge/hello` message before any ACP traffic:

```jsonc
// Agentlet → Server
{
  "jsonrpc": "2.0",
  "method": "bridge/hello",
  "id": 1,
  "params": {
    "token": "tok_abc123...",
    "agentId": "yuqyang-laptop:claude:my-project:a1b2c3d4",
    "bridge": {
      "name": "agentlet",
      "version": "1.0.0"
    },
    "agent": {
      "command": "claude --acp --stdio",
      "pid": 12345
    },
    "machine": {
      "hostname": "yuqyang-laptop",
      "platform": "win32"
    },
    "capabilities": {
      "autoRestart": true,
      "bufferLimit": 1000
    }
  }
}
```

```jsonc
// Server → Agentlet (success)
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "agentId": "yuqyang-laptop:claude:my-project:a1b2c3d4",
    "status": "connected"
  }
}
```

```jsonc
// Server → Agentlet (failure)
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "Invalid or expired token"
  }
}
```

On successful handshake, the WebSocket enters **relay mode** — all subsequent messages are raw ACP JSON-RPC forwarded transparently.

### 5.3 Message Relay (Steady State)

```
Server → Agentlet → Agent stdin:   ACP requests  (initialize, session/new, session/prompt, ...)
Agent stdout → Agentlet → Server:  ACP responses (results, notifications, streaming chunks)
```

**Framing:** Each WebSocket text frame contains exactly one JSON-RPC message (same as ACP stdio framing — newline-delimited JSON on stdio, one message per WS frame on WebSocket).

**Agentlet behavior:**
- Read stdout line-by-line; parse as JSON; forward each valid JSON-RPC message as a WebSocket text frame.
- Read each WebSocket text frame; write as a line to agent stdin (append `\n`).
- Invalid JSON from stdout: log warning, skip (do not forward garbage to server).
- Binary WebSocket frames: reject and log (protocol violation).

### 5.4 Bridge Control Messages

These are **not** ACP messages — they are bridge-level events sent alongside ACP traffic. They use the `bridge/` method namespace to avoid collision with ACP methods.

| Direction | Method | When | Params |
|---|---|---|---|
| Agentlet → Server | `bridge/hello` | On connect | See §6.2 |
| Agentlet → Server | `bridge/agent_exited` | Agent process exits | `{ "code": 0, "signal": null, "willRestart": true }` |
| Agentlet → Server | `bridge/agent_restarted` | Agent restarted after crash | `{ "pid": 12346, "attempt": 2 }` |
| Agentlet → Server | `bridge/goodbye` | Bridge shutting down gracefully | `{ "reason": "user_interrupt" }` |
| Agentlet → Server | `bridge/buffer_overflow` | Buffer limit reached during disconnect | `{ "dropped": 12 }` |
| Server → Agentlet | `bridge/replay` | After reconnection handshake | `{ "messages": [/* buffered ACP messages */] }` |
| Server → Agentlet | `bridge/ping` | Keepalive (if heartbeat enabled) | `{}` |
| Server → Agentlet | `bridge/pong` | Response to ping | `{}` |
| Server → Agentlet | `bridge/shutdown` | Server requests bridge to terminate | `{ "reason": "token_revoked" }` |

- `bridge/hello` is a **request** (has `id`, expects a response). All others are **notifications** (no `id`, no response expected).
- Heartbeat: The agent-side adapter sends WebSocket-level pings at `--heartbeat` interval. `bridge/ping` / `bridge/pong` are application-level keepalives initiated by the server for connection liveness detection.

### 5.5 Reconnection Protocol

When the WebSocket drops unexpectedly:

1. **Buffer**: Continue reading agent stdout into an in-memory queue (up to `--buffer-limit` messages).
2. **Backoff**: Reconnect attempts with exponential backoff: 1s, 2s, 4s, 8s, ... capped at `--reconnect-max`.
3. **Re-handshake**: On reconnection, send `bridge/hello` again (with same token).
4. **Server replay first**: If the server has buffered outbound messages (from host app `send()` calls during disconnect), it sends `bridge/replay` immediately after the hello response.
5. **Client replay second**: After receiving the hello response (and any `bridge/replay`), Agentlet flushes its own buffered messages to the server in order.
6. **Resume**: Normal relay resumes.

```mermaid
sequenceDiagram
    participant Local as agentlet (agent-side)
    participant GW as @agentlet/server

    Note over Local,GW: WebSocket drops unexpectedly
    Local--xGW: (connection lost)

    Note over Local: Buffering agent stdout...<br/>(agent subprocess unaffected)
    Note over GW: Buffering host app send() calls...

    Local->>GW: WebSocket open (reconnect attempt)
    Local->>GW: bridge/hello {same agentId, same token}
    GW-->>Local: hello response {agentId, status: "connected"}
    GW->>Local: bridge/replay {messages: [...]}
    Note over Local: Writes replayed messages to agent stdin
    Local->>GW: (flush buffered stdout messages)
    Note over Local,GW: Normal relay resumes
```

**Agent subprocess is never restarted due to network issues.** The agent continues running, writing to stdout, which Agentlet buffers. From the agent's perspective, nothing happened.

---

### 5.6 Protocol Type Reference

The definitive type contract for the bridge protocol lives in `@agentlet/protocol` (source of truth). See the source files directly:

| Types | Source |
|---|---|
| **Base Types** — `JsonRpcRequest`, `JsonRpcNotification`, `JsonRpcResponse`, `JsonRpcError`, `JsonRpcMessage`, `AcpMessage` | [`packages/protocol/src/json-rpc.ts`](packages/protocol/src/json-rpc.ts) |
| **Bridge Hello** — `BridgeHelloParams`, `BridgeHelloResult`, `BridgeHelloError` | [`packages/protocol/src/bridge-messages.ts`](packages/protocol/src/bridge-messages.ts) |
| **Bridge Control Notifications** — `BridgeAgentExitedParams`, `BridgeAgentRestartedParams`, `BridgeGoodbyeParams`, `BridgeBufferOverflowParams`, `BridgeReplayParams`, `BridgePingParams`, `BridgePongParams`, `BridgeShutdownParams` | [`packages/protocol/src/bridge-messages.ts`](packages/protocol/src/bridge-messages.ts) |
| **Lifecycle Events** — `BridgeLifecycleEvent` | [`packages/protocol/src/bridge-messages.ts`](packages/protocol/src/bridge-messages.ts) |
| **Server Configuration** — `AgentletServerOptions`, `AuthResult` | [`packages/protocol/src/gateway-types.ts`](packages/protocol/src/gateway-types.ts) |
| **AgentConnection** — the interface host apps interact with | [`packages/protocol/src/gateway-types.ts`](packages/protocol/src/gateway-types.ts) |
| **Error Codes & Constants** — `BridgeErrorCodes`, `BridgeMethods`, `PROTOCOL_VERSION` | [`packages/protocol/src/constants.ts`](packages/protocol/src/constants.ts) |

#### Error Codes (quick reference)

| Code | Name | When |
|------|------|------|
| `-32001` | `INVALID_TOKEN` | Token is invalid, expired, or revoked |
| `-32002` | `VERSION_MISMATCH` | Bridge protocol version is incompatible |
| `-32003` | `HANDSHAKE_TIMEOUT` | `bridge/hello` not received within timeout |
| `-32600` | `INVALID_REQUEST` | Malformed JSON-RPC (standard JSON-RPC error) |
| `-32700` | `PARSE_ERROR` | Invalid JSON (standard JSON-RPC error) |

---

## 7. Security Considerations

| Concern | Mitigation |
|---|---|
| **Token exposure** | Token is passed via CLI argument. Recommend: environment variable (`AGENTLET_TOKEN`) as alternative. Token should be short-lived and revocable from the server. |
| **WebSocket TLS** | Production connections MUST use `wss://`. Agentlet should reject `ws://` unless `--allow-insecure` is explicitly passed (for local development only). |
| **Agent command injection** | The `--agent` value is passed to `spawn` with `shell: true`. Document that users should only run trusted agent commands. |
| **Message integrity** | Agentlet relays messages verbatim — no validation of ACP semantics. Server-side must validate all incoming ACP messages. |
| **Credential isolation** | Agentlet never touches the agent's credentials (API keys, SSH keys). Those live in the agent's own process environment. |
| **Token revocation** | If the server revokes the token, it sends `bridge/shutdown`. Agentlet terminates agent and exits. |

---

## 8. Observability

### Logging

Structured JSON-lines output when `--log-file` is specified:

```jsonc
{"ts":"2026-05-20T10:30:00Z","level":"info","event":"ws_connected","server":"wss://app.example.com/api/bridge"}
{"ts":"2026-05-20T10:30:00Z","level":"info","event":"agent_spawned","pid":12345,"command":"claude --acp --stdio"}
{"ts":"2026-05-20T10:30:01Z","level":"info","event":"handshake_ok","agentId":"dev-laptop:claude:my-project:a1b2c3d4"}
{"ts":"2026-05-20T10:35:22Z","level":"warn","event":"ws_disconnected","code":1006,"reason":""}
{"ts":"2026-05-20T10:35:23Z","level":"info","event":"reconnecting","attempt":1,"backoff_ms":1000}
{"ts":"2026-05-20T10:35:24Z","level":"info","event":"ws_reconnected","buffered_replayed":3}
```

### Metrics (future)

Optional Prometheus-compatible metrics endpoint (`--metrics-port`):

- `agentlet_messages_relayed_total{direction="to_server|to_agent"}`
- `agentlet_ws_reconnections_total`
- `agentlet_buffer_depth`
- `agentlet_agent_restarts_total`
- `agentlet_uptime_seconds`

---

## 9. Technology Choices

| Decision | Choice | Rationale |
|---|---|---|
| **Language** | TypeScript (Node.js) | Excellent child process and WebSocket support; broad ecosystem familiarity. |
| **WebSocket client** | `ws` (npm) | De-facto standard, lightweight, well-maintained. |
| **CLI parsing** | `commander` or `yargs` | Mature, minimal dependencies. |
| **Process management** | Node.js `child_process.spawn` | Native, no extra dependencies. |
| **Packaging** | Single executable via `pkg` or `esbuild` bundle | Zero-dependency distribution for users without Node.js installed. |
| **Distribution** | npm (`npm install -g agentlet`) + standalone binaries | Dual distribution for different user preferences. |
| **ACP dependency** | None — define minimal JSON-RPC 2.0 types in `@agentlet/protocol` | Agentlet is transport-only; never interprets ACP semantics. Avoids coupling to evolving ACP spec. Host apps bring their own ACP SDK if needed. |

---

## 10. Future Evolution

### When ACP HTTP/WebSocket transport stabilizes

The [Streamable HTTP & WebSocket Transport RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport) (Working Group formed April 2026) will allow agents to expose a native HTTP/WebSocket endpoint.

**Impact on Agentlet:**

| Scenario | Agentlet's role |
|---|---|
| Agent exposes local HTTP endpoint | Agentlet becomes a **WebSocket tunnel** only — no subprocess management. Connects to agent's local HTTP and relays to remote server's WSS. Simpler, ~100 lines. |
| Agent exposes public WebSocket | Agentlet is **unnecessary** — remote server connects directly to agent. Agentlet retired for that agent. |
| Agent is still stdio-only | No change — Agentlet continues as today. |

The current architecture is **forward-compatible**: the bridge/hello handshake and relay protocol remain identical regardless of how the agent is reached locally. Only the "local side" connector changes.

### Multi-agent support

**Current design:** The relay server and Web UI **natively support multiple agents** — any number of agent-side adapters can connect simultaneously, each identified by its unique `agentId`. The server maintains a connection registry (`Map<agentId, AgentConnection>`), the REST API lists all agents, and the UI provides an agent selector.

**Agent-side:** Each `agentlet` CLI instance spawns and manages exactly **one** agent process. To connect multiple agents, run multiple `agentlet` instances (one per agent). This keeps each bridge simple and independently restartable.

**Future (post-v1):** A single `agentlet` instance managing multiple agents via config file:

```bash
agentlet --config agents.yaml --server "wss://app.example.com/api/bridge"
```

```yaml
# agents.yaml
agents:
  - name: claude
    command: "claude --acp --stdio"
    token: "tok_111"
    cwd: "/home/user/project-a"
  - name: copilot
    command: "copilot --acp --stdio"
    token: "tok_222"
    cwd: "/home/user/project-b"
```

---

## 11. Project Structure

```
agentlet/
├── packages/
│   ├── local/                    # Agent-side adapter (CLI tool: `agentlet`)
│   │   ├── src/
│   │   │   ├── index.ts          # CLI entry point
│   │   │   ├── cli.ts            # Argument parsing & validation
│   │   │   ├── bridge.ts         # Core orchestrator (lifecycle state machine)
│   │   │   ├── agent-process.ts  # Subprocess spawning, stdio handling, restart logic
│   │   │   ├── ws-client.ts      # WebSocket connection, reconnection, buffering
│   │   │   ├── relay.ts          # Message framing & bidirectional forwarding
│   │   │   └── logger.ts         # Structured logging
│   │   ├── tests/
│   │   └── package.json          # name: "agentlet"
│   │
│   ├── server/                    # Relay server (`@agentlet/server`)
│   │   ├── src/
│   │   │   ├── index.ts          # Public API exports
│   │   │   ├── server.ts         # Main AgentletServer class (connection registry, lifecycle)
│   │   │   ├── connection.ts     # AgentConnection implementation
│   │   │   ├── handshake.ts      # bridge/hello validation & response
│   │   │   ├── host-ws.ts        # Host-side WebSocket endpoint (standalone mode)
│   │   │   ├── rest-api.ts       # REST endpoints (standalone mode)
│   │   │   └── standalone.ts     # CLI entry point for standalone mode
│   │   ├── tests/
│   │   └── package.json          # name: "@agentlet/server"
│   │
│   ├── client/                    # Host-side SDK (`@agentlet/client`)
│   │   ├── src/
│   │   │   ├── index.ts          # Public API exports
│   │   │   └── client.ts         # AgentletClient — connects to standalone server
│   │   ├── tests/
│   │   └── package.json          # name: "@agentlet/client"
│   │
│   ├── ui/                        # Built-in Web UI (`@agentlet/ui`)
│   │   ├── src/
│   │   │   ├── main.ts           # Vue app entry point
│   │   │   ├── App.vue           # Root component (layout, agent selector)
│   │   │   ├── components/
│   │   │   │   ├── ChatView.vue      # Chat interface (prompts, responses, streaming)
│   │   │   │   ├── AgentSelector.vue  # Connected agents picker
│   │   │   │   ├── PermissionDialog.vue  # Agent permission approval UI
│   │   │   │   ├── TrafficMonitor.vue    # Raw ACP message inspector
│   │   │   │   └── SessionList.vue       # Session management
│   │   │   ├── stores/
│   │   │   │   ├── session.ts    # ACP session state (Pinia)
│   │   │   │   └── agents.ts     # Agent connection state (from REST API)
│   │   │   └── lib/
│   │   │       └── transport.ts  # ACP WebSocket transport (connects to /agents/:id/ws)
│   │   ├── index.html            # SPA shell
│   │   ├── vite.config.ts
│   │   └── package.json          # name: "@agentlet/ui"
│   │
│   └── protocol/                  # Shared protocol definitions (`@agentlet/protocol`)
│       ├── src/
│       │   ├── index.ts          # Public exports
│       │   ├── json-rpc.ts       # JSON-RPC 2.0 base types
│       │   ├── bridge-messages.ts # bridge/* message type definitions
│       │   ├── server-types.ts   # AgentletServerOptions, AgentConnection, AuthResult
│       │   └── constants.ts      # Protocol version, method names, error codes
│       └── package.json          # name: "@agentlet/protocol"
│
├── package.json                   # Workspace root (pnpm)
├── pnpm-workspace.yaml
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

---

## 12. Milestone Plan

| Milestone | Scope | Exit Criteria | Status |
|---|---|---|---|
| **M1: Transparent relay** | Spawn agent, connect WSS, relay messages. No reconnection, no restart. | Can relay ACP `initialize` → response between a mock agent and a mock server. | ✅ Done |
| **M2: Resilience** | Reconnection with buffering, exponential backoff, replay. | Survives 30s network disconnect without losing messages. Agent unaffected. | Not started |
| **M3: Agent lifecycle** | Auto-restart, graceful shutdown, exit reporting. | Agent crash → auto-restart → server notified → new session resumes. | Not started |
| **M4: Standalone server** | REST API, host-side WS, per-agent raw ACP WS endpoint, static token auth. | `agentlet-server --port 8080` works; agents connectable via REST + WS. | ✅ Done |
| **M5: Web UI** | Built-in Vue 3 SPA: chat, agent selector, permissions, traffic monitor. | Can chat with a connected agent via browser at `http://localhost:8080/`. | ✅ Done |
| **M6: Production readiness** | TLS enforcement, logging, error handling, tests, docs. | CI green, README complete, npm publishable. | Not started |
| **M7: Distribution** | Standalone binaries (macOS, Linux, Windows). | `npx agentlet` works; standalone binary works without Node.js. | Not started |

---

## Appendix A: ACP Message Examples

For reference — these are the ACP messages that flow **through** Agentlet transparently. Agentlet does not interpret them.

```jsonc
// Server → Agent: Initialize the ACP session
{ "jsonrpc": "2.0", "method": "initialize", "id": 1, "params": { "clientInfo": { "name": "huabu", "version": "1.0" } } }

// Agent → Server: Initialization response
{ "jsonrpc": "2.0", "id": 1, "result": { "agentInfo": { "name": "claude-code", "version": "2.1" }, "capabilities": { "streaming": true } } }

// Server → Agent: Start a new session
{ "jsonrpc": "2.0", "method": "session/new", "id": 2, "params": { "cwd": "/home/user/project" } }

// Server → Agent: Send a prompt
{ "jsonrpc": "2.0", "method": "session/prompt", "id": 3, "params": { "sessionId": "sess_1", "prompt": [{ "type": "text", "text": "Refactor the auth module to use JWT" }] } }

// Agent → Server: Streaming response chunks (notifications, no id)
{ "jsonrpc": "2.0", "method": "session/message", "params": { "sessionId": "sess_1", "message": { "type": "agent", "content": [{ "type": "text", "text": "I'll start by..." }] } } }

// Agent → Server: Permission request
{ "jsonrpc": "2.0", "method": "session/permission", "id": 4, "params": { "sessionId": "sess_1", "permission": { "type": "tool_call", "tool": "bash", "args": { "command": "rm -rf node_modules" } } } }

// Server → Agent: Permission granted
{ "jsonrpc": "2.0", "id": 4, "result": { "granted": true } }

// Server → Agent: Cancel a running session
{ "jsonrpc": "2.0", "method": "session/cancel", "id": 5, "params": { "sessionId": "sess_1" } }
```

---

## Appendix B: Server-Side Contract

Agentlet is intentionally server-agnostic. Any system can accept Agentlet connections by implementing:

1. **WebSocket endpoint** — accepts incoming WSS connections.
2. **`bridge/hello` handshake** — validates the token, echoes back the `agentId` and status.
3. **ACP Client behavior** — sends standard ACP JSON-RPC requests (`initialize`, `session/new`, `session/prompt`, etc.) and receives responses/notifications.
4. **Bridge control messages** — handles `bridge/agent_exited`, `bridge/goodbye`, etc. as lifecycle signals.
5. **Reconnection** — recognizes a reconnecting bridge (same token) and optionally replays lost messages.

This enables:

- **Independent development** — Agentlet can be versioned, released, and tested without any specific server deployment.
- **Ecosystem reuse** — Any application (IDE backend, AI canvas, CI orchestrator, research platform) can integrate by implementing the server side of this contract.
- **User trust** — Agentlet is open-source and auditable. Users can verify it doesn't exfiltrate code (it's ~500 lines of relay logic with no network calls beyond the configured server).
- **Minimal install** — Users install one small tool. No SDK, no heavy dependencies.
