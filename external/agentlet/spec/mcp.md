# MCP Integration Proposal

> **Status**: Deferred — lower priority, not planned for near-term implementation  
> **Date**: 2025-06-17 (updated 2026-06-19)  
> **Authors**: @mydmdm

## Overview

Agent sessions connected through the agentlet relay can access **MCP tools** hosted alongside the relay server. This enables remote agents to invoke server-side capabilities — file system operations, host-app callbacks, and cross-session communication — through the standard [Model Context Protocol](https://modelcontextprotocol.io/) tool-calling interface.

**Ultimate goal:** Enable cross-agent (cross-session) communication, where one agent session can discover, message, and coordinate with other sessions managed by the same relay — turning the agentlet system into a multi-agent orchestration platform.

```
Agent Session A (remote)
  ↓  MCP tools/call (HTTP)
MCP Server (independent, composes with AgentletServer)
  ↓  dispatches to tool handlers
[filesystem]  [session tools]  [host-app custom tools]
                    ↓
          AgentletServer public API
          (listSessions, sendToSession, etc.)
```

## Motivation

- **Remote file access** — agents on a different machine can read/write files on the host.
- **Cross-session communication** — one agent can discover peer sessions and send prompts to them, enabling multi-agent workflows.
- **Host-app extensibility** — host applications register custom tools (callbacks) for domain-specific workflows.
- **Centralized capability control** — the MCP server acts as a capability gateway with access policies.

## Design Decisions

### Architecture: Separation of Concerns

The MCP server is a **separate, independent component** — not built into `AgentletServer`. It accesses agentlet capabilities through `AgentletServer`'s public API (the same methods available to any consumer).

```
┌─────────────────────────────────────────────────────────────┐
│  Host App                                                    │
│                                                              │
│  ┌──────────────────┐      ┌───────────────────────────┐    │
│  │  AgentletServer  │      │  MCP Server               │    │
│  │  (relay only)    │◄─────│  (@agentlet/mcp)          │    │
│  │                  │ pub  │                           │    │
│  │  /api/bridge     │ API  │  /api/mcp                 │    │
│  └──────────────────┘      └───────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Rationale:**
- `AgentletServer` stays a **pure relay** with no MCP knowledge — no scope creep.
- The MCP server is independently testable, replaceable, and optional.
- Cross-session tools access the server through the **same public API** any host app code can use.
- Host apps have full control over which tools exist and how they're composed.

### Package Structure

```
@agentlet/server    — relay + public API (no MCP knowledge)
@agentlet/mcp       — MCP server + pre-built tool handlers
                      (consumes @agentlet/server's public API)
```

`@agentlet/mcp` exports helper functions that create pre-wired tool handlers:

```typescript
import { createAgentletTools } from '@agentlet/mcp'   // session tools
import { createFilesystemTools } from '@agentlet/mcp'  // filesystem tools
import { createMcpServer } from '@agentlet/mcp'        // MCP HTTP server
```

### Transport

**HTTP (Streamable HTTP)** as defined in the [MCP specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http).

- Single MCP endpoint mounted by the host app (e.g., `/api/mcp`).
- Standard MCP HTTP client in the agent framework connects to it.
- No protocol customization — all tools use standard synchronous `tools/call` request-response in phase 1.

### Authentication

Reuses the existing **bridge token** shared between the daemon and server.

**Token flow:**

1. The daemon spawns the agent process with env var `AGENTLET_TOKEN=<bridge-token>`.
2. The `sessionSpec.mcpServers` config references the token via variable interpolation:
   ```json
   {
     "type": "http",
     "name": "agentlet",
     "url": "http://<server-host>:<port>/api/mcp",
     "headers": { "Authorization": "Bearer ${AGENTLET_TOKEN}" }
   }
   ```
3. The agent's MCP client resolves `${AGENTLET_TOKEN}` from the process environment at the transport layer.
4. The MCP server validates the token via the same `authenticate` callback used for bridge connections.

**Security properties:**
- The actual token **never appears** in the `session/new` JSON-RPC message — only the `${AGENTLET_TOKEN}` placeholder travels over stdio.
- The token is resolved by the agent framework's transport layer — **not** exposed to the LLM.
- No additional OAuth ceremony needed.

### Access Control: Same-Token Visibility

Sessions sharing the same bridge token (same owner) can see and communicate with each other. This is the simplest model that enables multi-agent coordination while maintaining isolation between different users/apps.

- `list_sessions` returns only sessions belonging to the same token owner.
- `send_to_session` can only target sessions under the same owner.
- Per-session identity (which specific session is calling) is a **future enhancement** — not required for phase 1.

### Tool Sources

1. **Agentlet session tools** — pre-built handlers that use `AgentletServer`'s public API (e.g., `list_sessions`, `send_to_session`).
2. **Filesystem tools** — file operations on the server machine.
3. **Host-app custom tools** — domain-specific callbacks registered by the host app.

### Tool Scope

- **Phase 1:** All tools are **global** — every agent session sees the same set.
- **Future:** Per-session tool selection via `sessionSpec.mcpServers` configuration.

### Execution Context

Tools execute on the **server machine**. Remote agents can access host-side resources (files, APIs, other sessions) through MCP tools running locally on the server.

### Tool Lifecycle

Tools are registered **statically at server startup**. Dynamic registration is out of scope for phase 1.

### Tool Call Semantics

All tool calls are **synchronous request-response**, following standard MCP `tools/call` behavior:
- Client sends `tools/call` request.
- Server executes the handler.
- Server returns the result in the response.

For `send_to_session`: the call **blocks until the target session completes its response** (with a configurable timeout). The target's response content is returned directly as the tool result.

No custom notifications, polling, or async patterns in phase 1 — pure standard MCP.

## AgentletServer Public API (New Methods)

The MCP session tools require new public methods on `AgentletServer`:

```typescript
interface AgentletServer {
  // Existing methods
  getConnections(filter?): AgentConnection[]
  getConnection(sessionId): AgentConnection | null
  spawnOnAgentlet(agentletId, opts): Promise<{ sessionId, pid }>

  // New methods for cross-session communication
  sendToSession(sessionId: string, message: JsonRpcMessage): void
  getSessionHistory(sessionId: string, opts?: { afterSeq?: number }): SessionEvent[]
}
```

These methods are useful beyond MCP — host app code can also call them directly.

## Host App Integration

### Composing the MCP server

```typescript
import { AgentletServer } from '@agentlet/server'
import { createMcpServer, createAgentletTools, createFilesystemTools } from '@agentlet/mcp'

// 1. Create AgentletServer (unchanged — pure relay)
const server = new AgentletServer({
  storeDir: './data/agentlet',
  authenticate: async (token) => {
    if (token !== process.env.AGENTLET_TOKEN) throw new Error('bad token')
    return { metadata: {} }
  },
  onConnection: (agent) => console.log('connected:', agent.sessionId),
})

// 2. Create MCP server — wired to AgentletServer's public API
const mcpServer = createMcpServer({
  authenticate: (token) => server.authenticate(token),
  tools: [
    ...createAgentletTools(server),           // list_sessions, send_to_session
    ...createFilesystemTools('/workspace'),   // read_file, write_file, list_dir
    // Host-app custom tools
    {
      name: 'deploy',
      description: 'Deploy the application',
      inputSchema: { type: 'object', properties: { env: { type: 'string' } }, required: ['env'] },
      handler: async (args) => { /* custom logic */ return 'Deployed to ' + args.env },
    },
  ],
})

// 3. Mount both on the host app's HTTP server
httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/api/bridge') server.handleUpgrade(req, socket, head)
})
app.all('/api/mcp', (req, res) => mcpServer.handleRequest(req, res))
```

### Including MCP in sessionSpec

The MCP client config is passed through `sessionSpec.mcpServers`, aligning with ACP's `session/new` parameters:

```typescript
// sessionSpec mirrors ACP session/new params
interface SessionSpec {
  command: string
  cwd: string
  autoRestart?: boolean
  idleTimeoutSecs?: number
  mcpServers?: McpServerConfig[]  // ← passed through to session/new
}
```

The host app includes the MCP config when spawning:

```typescript
const MCP_CONFIG = {
  type: 'http',
  name: 'agentlet',
  url: 'http://localhost:3001/api/mcp',
  headers: { 'Authorization': 'Bearer ${AGENTLET_TOKEN}' },
}

await server.spawnOnAgentlet(agentletId, {
  appId: threadId,
  sessionSpec: {
    command: 'copilot --acp --allow-all',
    cwd: '/project',
    mcpServers: [MCP_CONFIG],
  },
})
```

### Daemon-side pass-through

The daemon receives `mcpServers` in the `server/spawn` payload and passes it directly to `session/new`:

```typescript
// session-bootstrap.ts — no special MCP logic
const response = await sendRequest(agent, 2, 'session/new', {
  cwd: options.cwd,
  mcpServers: options.mcpServers ?? [],
}, timeout)
```

The daemon also sets `AGENTLET_TOKEN=<bridge-token>` in the agent process environment.

## Builtin Tools

### Filesystem Tools (`createFilesystemTools(root)`)

| Tool | Parameters | Returns |
|------|-----------|---------|
| `read_file` | `path: string` | File content as text |
| `write_file` | `path: string, content: string` | Confirmation message |
| `list_dir` | `path: string` | Array of `{ name, type }` entries |

All paths are resolved relative to `root`. Traversal outside `root` is rejected.

### Agentlet Session Tools (`createAgentletTools(server)`)

| Tool | Parameters | Returns |
|------|-----------|---------|
| `list_sessions` | (none) | Array of `{ sessionId, status, command, cwd }` for same-owner sessions |
| `send_to_session` | `sessionId: string, prompt: string` | Target session's response content (blocks until complete, timeout configurable) |
| `get_session_history` | `sessionId: string, afterSeq?: number` | Array of session events |

**`send_to_session` behavior (phase 1):**
- Synchronous: blocks until target session finishes its turn.
- Configurable timeout (default: 120s).
- On timeout: returns `isError: true` with timeout message.
- On success: returns the target session's response as MCP text content.

## Session Bootstrap Flow

```
1. Host app creates AgentletServer + MCP server (at startup)

2. Host app calls spawnOnAgentlet({ sessionSpec: { ..., mcpServers: [MCP_CONFIG] } })
   └─→ Server sends server/spawn to daemon (includes mcpServers)

3. Daemon spawns agent process
   └─→ Sets env: AGENTLET_TOKEN=<bridge-token>

4. Daemon bootstraps ACP session: session/new
   └─→ params.mcpServers: [{ type: 'http', url: '.../api/mcp', headers: {...} }]

5. Agent's ACP framework starts MCP client
   └─→ Resolves ${AGENTLET_TOKEN} from env
   └─→ Sends tools/list to /api/mcp with Bearer token
   └─→ Discovers: read_file, write_file, list_dir, list_sessions, send_to_session, ...

6. During conversation, agent invokes tools
   └─→ POST /api/mcp with tools/call + Bearer token
   └─→ MCP server validates token, executes handler, returns result
```

## Cross-Session Communication Example

```
Agent A (orchestrator):
  → tools/call: list_sessions()
  ← [{ sessionId: "sess_B", status: "connected", command: "copilot..." }]

  → tools/call: send_to_session({ sessionId: "sess_B", prompt: "Run the tests" })
  ← (blocks while B processes...)
  ← { content: [{ type: "text", text: "All 42 tests passed. See report at..." }] }
```

## Standalone Mode

When running `agentlet-server` as a CLI:
- `--mcp` flag enables MCP with default builtin tools (filesystem + session tools).
- `--mcp-path <path>` configures the endpoint path (default: `/mcp`).
- `--mcp-root <dir>` sets the filesystem tools root directory.
- URL is auto-derived from `--host`/`--port`.

```bash
agentlet-server --port 8080 --token "tok_123" --mcp --mcp-root /workspace
```

## Future Considerations

- **Per-session identity** — per-session MCP tokens for audit logging and fine-grained access control.
- **Per-session tool selection** — `sessionSpec` specifies which tool names are visible to a specific session.
- **Dynamic tool registration** — host apps add/remove tools at runtime.
- **Async `send_to_session`** — fire-and-forget with tracking ID + `get_response` polling tool.
- **Server-push notifications** — use MCP's GET SSE channel for async result delivery.
- **Bidirectional MCP** — server acts as MCP *client* to aggregate external MCP servers.
- **Streaming tool results** — long-running tools stream partial results via SSE.
- **Tool authorization** — fine-grained per-tool permissions, human-in-the-loop approval.
