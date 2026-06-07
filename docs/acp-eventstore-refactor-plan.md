# Refactor: Drop Redundant ACP Re-initialization — Use EventStore Subscriptions

## 1. Problem

When Huabu opens a chat thread bound to an external agent, two layers of ACP
initialization happen:

```
Layer 1 — Agentlet daemon (session-bootstrap.ts, runs in child process)
  1. initialize        → agent returns capabilities
  2. session/new       → agent returns sessionId
  3. agent/hello       → opens WS relay, server records SessionRecord + starts EventStore

Layer 2 — Huabu server (service.ts::ensureAcpSessionInner)
  4. AcpAgentClient(conn)   → wraps the relay AgentConnection in the ACP SDK
  5. client.initialize()    → SECOND initialize to the same agent
  6. client.newSession()    → SECOND session/new  → gets a DIFFERENT sessionId
  7. client.prompt(sid2, …) → prompts using sid2, not sid1
```

This is wasteful and introduces a split-brain problem: the WS relay is keyed by
`sessionId-1` (from the daemon's bootstrap), but Huabu's prompt traffic uses
`sessionId-2` (from its own `session/new`). The daemon's EventStore records
events for `sessionId-1`, while the actual conversation happens on
`sessionId-2` — making EventStore useless for replay/persistence.

### Why it was this way

The `AcpAgentClient` wraps the `@anthropic-ai/acp` SDK's `ClientSideConnection`,
which enforces a state machine: `initialize() → newSession() → prompt()`. When
the SDK was first integrated, the daemon did not do session bootstrap — it was
a raw WS relay. The SDK handled the full ACP lifecycle.

The latest agentlet upgrade (`session-bootstrap.ts`) moved initialization into
the daemon, but Huabu was never updated to stop re-initializing.

## 2. Target Architecture

After the agent's WS relay connects (`agent/hello`), the session is **ready**.
Huabu should:

1. Read the `SessionRecord` from `DataStore` for capabilities, `initializeResult`
2. Subscribe to the `EventStore` for live `session/update` events
3. Send `session/prompt` directly via `AgentConnection.send()` (raw JSON-RPC)
4. Handle `session/request_permission` via `AgentConnection.onMessage()`

This mirrors the `host/subscribe` + `host/send` pattern from the standalone
agentlet-server, but using in-process TypeScript APIs instead of WebSocket.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Before (current)                                                   │
│                                                                     │
│  spawn → getConnection(sid1) → AcpAgentClient(conn)                │
│    → client.initialize()     ← 2nd initialize (wasteful)           │
│    → client.newSession()     ← 2nd session/new → sid2 (diverges!)  │
│    → client.prompt(sid2, …)  ← uses wrong sessionId for EventStore │
│    → conn.onMessage()        ← session/update dispatch via SDK      │
│                                                                     │
│  After (proposed)                                                   │
│                                                                     │
│  spawn → getConnection(sid1)                                        │
│    → dataStore.getSession(sid1)   ← read initializeResult, caps    │
│    → eventStore.subscribe(sid1, cb) ← live session/update events   │
│    → conn.send(prompt)            ← raw JSON-RPC, no SDK overhead  │
│    → conn.onMessage()             ← permission requests + responses │
└─────────────────────────────────────────────────────────────────────┘
```

## 3. Key In-Process APIs (from @agentlet/server)

These replace the `host/subscribe` + `host/send` WS protocol:

| Standalone WS method             | In-process equivalent                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `host/subscribe {sid, afterSeq}` | `server.getEventStore().subscribe(sid, cb)` + `.getEventsSince(sid, afterSeq)`     |
| `host/send {sid, message}`       | `server.getConnection(sid).send(message)`                                          |
| `host/unsubscribe {sid}`         | call the unsubscribe function returned by `.subscribe()`                           |
| `agent/connected` broadcast      | `onConnection` callback in `AgentletServerOptions`                                 |
| `agent/disconnected` broadcast   | `onDisconnection` callback in `AgentletServerOptions`                              |
| Session metadata                 | `server.getDataStore().getSession(sid)` → `initializeResult`, `supportsLoad`, etc. |

### EventEntry shape

```typescript
interface EventEntry {
  seq: number; // per-session monotonic sequence
  ts: string; // ISO 8601 timestamp
  dir: 'agent' | 'host'; // who sent it
  event: AcpMessage; // raw JSON-RPC message
}
```

- `dir === 'agent'`: messages FROM the agent (session/update, responses)
- `dir === 'host'`: messages TO the agent (session/prompt, etc.)
- Every message passing through `AgentConnection.send()` or `.onMessage()` is
  automatically persisted via `wireEventPersistence()` in the server.

## 4. Migration Steps

### Step 1: Create `AcpSessionBridge` (new file)

Replace `AcpAgentClient` with a lighter wrapper that does NOT use the ACP SDK.

```
apps/server/src/modules/agent/acp/session-bridge.ts
```

Responsibilities:

- Accept `AgentConnection` + `sessionId` + `DataStore.SessionRecord`
- Provide `prompt(text, onUpdate, signal?, onPermission?)` — sends raw
  `session/prompt` JSON-RPC request, installs `conn.onMessage()` handler
  to dispatch `session/update` notifications
- Provide `cancel(sessionId)` — send `session/cancel` notification
- Provide `setSessionMode/Model/ConfigOption` — send raw JSON-RPC requests
- Handle `session/request_permission` via the same `onMessage` handler
- Expose `initializeResult` from the `SessionRecord` (no re-initialize)
- Expose `subscribeEvents(afterSeq, cb)` — wraps `EventStore.subscribe()` +
  `getEventsSince()` for replay

Key differences from `AcpAgentClient`:

- NO `ClientSideConnection` (no SDK)
- NO `initialize()` or `newSession()` / `loadSession()`
- NO `streamFromAgentConnection()` (no ReadableStream/WritableStream wrapping)
- Uses `conn.send()` and `conn.onMessage()` directly
- Session/update interception is built-in (no stream adapter needed)

### Step 2: Update `ensureAcpSession` in `service.ts`

Replace the current flow:

```typescript
// Current (remove):
const client = new AcpAgentClient(conn, { canvasId, logger });
await client.initialize();
// ... loadSession / newSession
const newResult = await client.newSession({ cwd });
sessionId = newResult.sessionId;
```

With:

```typescript
// New:
const record = server.getDataStore().getSession(agentSessionId);
if (!record || record.status !== 'active') {
  throw new Error(`Session ${agentSessionId} not found or not active`);
}
const bridge = new AcpSessionBridge(conn, agentSessionId, record, {
  canvasId,
  logger,
  eventStore: server.getEventStore(),
});
sessionId = agentSessionId; // USE the daemon's sessionId directly
```

The `sessionId` used for prompts is now the SAME one used for the WS relay
connection and EventStore — no more divergence.

### Step 3: Update `AcpSessionEntry`

Replace `client: AcpAgentClient` with `bridge: AcpSessionBridge` in the
session registry entry type.

```typescript
// session-registry.ts
export interface AcpSessionEntry {
  bridge: AcpSessionBridge; // was: client: AcpAgentClient
  sessionId: string;
  // ... rest unchanged
}
```

### Step 4: Update `runAcpAgent` in `service.ts`

Replace:

```typescript
void entry.client.prompt(entry.sessionId, promptPayload, (update) => { … });
```

With:

```typescript
void entry.bridge.prompt(promptPayload, (update) => { … });
```

The `sessionId` is already bound in the bridge — no need to pass it.

### Step 5: Update `threads.route.ts`

Replace `entry.client.resolvePermission(…)` → `entry.bridge.resolvePermission(…)`.
Replace `entry.client.setSessionMode(…)` → `entry.bridge.setSessionMode(…)`.
Same for `setSessionModel`, `setSessionConfigOption`.

### Step 6: Update session recovery (server restart)

Current recovery path: `session/load` or "already loaded" detection via
`client.loadSession()`. With the new model:

- The daemon already handles session bootstrap including `session/resume`
  and `session/load` (see `session-bootstrap.ts:bootstrapResumeOrLoad`)
- The server's `DataStore.getSession(sessionId)` returns the session record
  with `supportsLoad`, `supportsResume`, and `initializeResult`
- On server restart, the daemon re-forks, re-bootstraps, and the session
  record is refreshed — Huabu just reads it

No more `client.loadSession()` from Huabu's side.

### Step 7: Seed session meta from DataStore

Currently `seedSessionMetaFromResponse(created, newResult, logger)` extracts
modes, models, config options from the `session/new` response. With the new
model, this data is available in `record.initializeResult` (which was
captured during the daemon's bootstrap and persisted by
`server.persistSessionRecord()`).

```typescript
const initResult = record.initializeResult as AcpInitializeResult;
seedSessionMetaFromResponse(created, initResult, logger);
```

Additionally, `session/update` notifications that carry meta updates
(available_commands, modes, models, etc.) will arrive via the EventStore
subscription, handled by the existing `handleSessionMetaUpdate()`.

### Step 8: Wire EventStore subscription for chat history

For the chat panel to survive refresh, subscribe to EventStore on session open:

```typescript
const eventStore = server.getEventStore();

// Replay + live subscription (same pattern as host-ws.ts handleSubscribe)
let lastSeq = 0;
const liveBuffer: EventEntry[] = [];
let replaying = true;

const unsub = eventStore.subscribe(sessionId, (entry) => {
  if (replaying) {
    liveBuffer.push(entry);
  } else if (entry.dir === 'agent') {
    // Live session/update — translate and push to SSE
    handleAgentEvent(entry.event);
  }
});

// Replay historical events
for (const entry of eventStore.getEventsSince(sessionId, lastSeq)) {
  if (entry.dir === 'agent') {
    handleAgentEvent(entry.event);
  }
  lastSeq = entry.seq;
}

// Drain live buffer, switch to live mode
for (const entry of liveBuffer) {
  if (entry.seq > lastSeq && entry.dir === 'agent') {
    handleAgentEvent(entry.event);
  }
}
replaying = false;
```

This gives us durable message history backed by JSONL files, surviving both
page refresh and server restart.

### Step 9: Deprecate & remove old code

- `AcpAgentClient` → eventually remove (keep temporarily for reference)
- `@anthropic-ai/acp` SDK dependency → remove once no consumers remain
- Orphan-update buffering → no longer needed (EventStore handles replay)
- `streamFromAgentConnection()` → no longer needed

## 5. What Does NOT Change

- **Agentlet subprocess lifecycle** — `daemon-supervisor.ts` is unchanged
- **Spawn orchestrator** — `spawnOnAgentlet()` / `ensureAgentForThread()`
  — same API, just the sessionId is now used directly
- **Translator** — `acpUpdateToStreamEvent()` still converts `session/update`
  payloads to `AgentStreamEvent`, but now receives them from `EventEntry.event`
  instead of the SDK's callback
- **Preprocessor** — `ExternalAgentPrompt` building is unchanged
- **Web client** — SSE transport, `useAgentStream`, `chatStore` are unchanged
- **AgentBinding / canvas data model** — stable
- **Auth** — `daemon-auth.ts` unchanged

## 6. Session/Prompt JSON-RPC Shape

For the raw `conn.send()` approach, the prompt message is:

```json
{
  "jsonrpc": "2.0",
  "method": "session/prompt",
  "id": 42,
  "params": {
    "sessionId": "sess_abc123",
    "prompt": [{ "type": "text", "text": "Hello agent" }]
  }
}
```

The response arrives via `conn.onMessage()`:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "stopReason": "end_turn"
  }
}
```

Session/update notifications (no `id` field) arrive interleaved:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": "Hello!"
    }
  }
}
```

## 7. Risk Assessment

| Risk                                                                  | Mitigation                                                                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission handling was deeply integrated with SDK                    | `session/request_permission` is a standard JSON-RPC request; replicate the suspend/resolve pattern from `AcpAgentClient` in `AcpSessionBridge`                 |
| `fs/read_text_file` capability handler was registered via SDK         | The SDK's `ClientSideConnection` registered this as a server-side handler. Need to handle `fs/*` requests in `conn.onMessage()` and respond with `conn.send()` |
| Session meta seeding from `initializeResult` may have different shape | Verify `SessionRecord.initializeResult` matches the shape `seedSessionMetaFromResponse()` expects                                                              |
| EventStore JSONL files grow unbounded                                 | Not a regression (they grow today too), but worth adding rotation later                                                                                        |
| `session/cancel` timing                                               | Same race as today — best-effort notification                                                                                                                  |

## 8. Effort Estimate

| Step                                   | Effort          |
| -------------------------------------- | --------------- |
| 1. `AcpSessionBridge`                  | 3-4 hours       |
| 2-5. Wire into service/routes          | 2-3 hours       |
| 6-7. Session recovery + meta seeding   | 1-2 hours       |
| 8. EventStore subscription for history | 1-2 hours       |
| 9. Cleanup + tests                     | 1-2 hours       |
| **Total**                              | **~8-13 hours** |

## 9. Open Questions

1. **`fs/read_text_file` handler**: The current SDK registers this as a
   capability handler. Without the SDK, we need to intercept `fs/*` requests
   in `conn.onMessage()` and respond directly. How is this currently
   implemented in `createClientHandler()`? Need to verify the exact requests
   the agent sends and replicate the sandbox logic.

2. **SpawnParams.sessionId**: When Huabu calls `spawnOnAgentlet()`, does the
   agentlet daemon use the `sessionId` from `SpawnParams` or generate a new
   one from `session/new`? If the daemon ignores `SpawnParams.sessionId`,
   Huabu can't predict the sessionId upfront — it must wait for the spawn
   response. (Current code: `session-bootstrap.ts` line 72 — `params.sessionId`
   is passed as `BootstrapOptions.sessionId`, and if provided, used for
   `session/resume` or `session/load` instead of `session/new`. If NOT
   provided, `session/new` returns a new sessionId. Currently Huabu does NOT
   pass `sessionId` in SpawnParams, so a new one is always created — this is
   fine, just need to be aware.)

3. **Multiple prompts on same session**: Does the agent support receiving
   `session/prompt` while a previous one is still in flight? The SDK enforced
   one-at-a-time; we should keep that guard in `AcpSessionBridge`.
