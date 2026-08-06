# Refactor: Drop Redundant ACP Re-initialization

> Status: **Superseded** · Last updated: 2026-07-14
>
> Superseded by [`agenetes-agentlet-gateway-consolidation.md`](../proposals/agenetes-agentlet-gateway-consolidation.md), which removes the agentlet-owned EventStore and DataStore rather than adapting them.

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

The `AcpAgentClient` wraps the `@agentclientprotocol/sdk`'s `ClientSideConnection`,
which was assumed to enforce a state machine: `initialize() → newSession() → prompt()`.
When the SDK was first integrated, the daemon did not do session bootstrap — it was
a raw WS relay. The SDK handled the full ACP lifecycle.

The latest agentlet upgrade (`session-bootstrap.ts`) moved initialization into
the daemon, but Huabu was never updated to stop re-initializing.

### Key Discovery: SDK Has No State Machine Guard

Upon auditing the compiled SDK (`@agentclientprotocol/sdk` v0.22.1), the
`Connection` class is a **pure JSON-RPC 2.0 transport**. Its `sendRequest()`
method (line 1211 of `acp.js`) only checks `this.abortController.signal.aborted`
— there is NO `initialized` flag, NO ordering enforcement. **You CAN call
`.prompt()` without calling `.initialize()` or `.newSession()` first.**

This enables a much simpler migration path: **keep the SDK but skip calling
`initialize()` and `newSession()`**.

## 2. Target Architecture (Option A — Keep SDK, Skip Re-init)

Instead of replacing the entire SDK with a custom `AcpSessionBridge`, we make a
surgical change: keep `AcpAgentClient` + the SDK's `ClientSideConnection` for
their bidirectional dispatch value, but skip the redundant init calls.

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
│  After (Option A)                                                   │
│                                                                     │
│  spawn → getConnection(sid1) → AcpAgentClient(conn)                │
│    → dataStore.getSession(sid1) ← read initializeResult from DB    │
│    → client.seedFromRecord(record) ← inject cached capabilities    │
│    → client.prompt(sid1, …)  ← uses daemon's sessionId directly    │
│    → conn.onMessage()        ← session/update dispatch via SDK      │
│                                                                     │
│  What SDK still provides:                                           │
│    • JSON-RPC request/response correlation (id → Promise)           │
│    • Bidirectional dispatch (inbound requests → handlers)           │
│    • fs/read_text_file + session/request_permission handling        │
│    • AbortController lifecycle                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Architecture — How SDK Connects to AgentletServer

```
┌──────────────────────────────────────────────────────────────────────┐
│ Huabu Server Process                                                 │
│                                                                      │
│  service.ts          client.ts                                       │
│  ┌──────────┐   ┌──────────────────────────────────────────┐        │
│  │ensureAcp │──▶│ AcpAgentClient                           │        │
│  │Session   │   │                                          │        │
│  │          │   │  ClientSideConnection (SDK)              │        │
│  │          │   │    ↕ reads/writes via Stream             │        │
│  │          │   │  streamFromAgentConnection()             │        │
│  │          │   │    ReadableStream ← conn.onMessage(cb)   │        │
│  │          │   │    WritableStream → conn.send(msg)       │        │
│  └──────────┘   └──────────────────┬───────────────────────┘        │
│                                    │                                 │
│  ┌─────────────────────────────────▼──────────────────────────────┐ │
│  │ AgentConnection (from server.getConnection(sessionId))         │ │
│  │   .send(msg)      → write to WebSocket                        │ │
│  │   .onMessage(cb)  → read from WebSocket                       │ │
│  │   .sessionId      → matches daemon's sessionId (sid1)         │ │
│  └────────────────────────────────┬───────────────────────────────┘ │
│                                   │ WS (localhost loopback)          │
│  ┌────────────────────────────────▼───────────────────────────────┐ │
│  │ AgentletServer (embedded, in-process)                          │ │
│  │   connections: Map<sessionId, AgentConnectionImpl>             │ │
│  │   EventStore:  persists all traffic as JSONL                   │ │
│  │   DataStore:   session metadata in SQLite (sessions.db)        │ │
│  │   wireEventPersistence(): auto-logs send/recv to EventStore    │ │
│  └────────────────────────────────┬───────────────────────────────┘ │
└───────────────────────────────────┼─────────────────────────────────┘
                                    │ WS (role=session&id=<sessionId>)
                                    ▼
                         ┌──────────────────────┐
                         │ Agent CLI Process     │
                         │ (forked by daemon)    │
                         │                      │
                         │ daemon bootstraps:   │
                         │   1. initialize      │
                         │   2. session/new     │
                         │   3. agent/hello     │
                         │      → WS relay open │
                         └──────────────────────┘
```

### Future Option B (Full refactor — deferred)

Replace `AcpAgentClient` entirely with `AcpSessionBridge` that uses raw
`conn.send()/onMessage()` + EventStore subscription. Cleaner but more risk.
Deferred until Option A proves stable.

## 3. Key In-Process APIs (from @agentlet/server)

Available for both Option A (supplement) and future Option B (primary):

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

### How the SDK Client Connects to AgentletServer

The SDK (`ClientSideConnection`) does NOT directly touch WebSockets. The
connection path is:

```
ClientSideConnection
  └─ reads from: ReadableStream<AnyMessage>  ← conn.onMessage(cb) enqueues
  └─ writes to:  WritableStream<AnyMessage>  → conn.send(msg) sends to WS
```

This bridging is done by `streamFromAgentConnection()` in `client.ts`:

1. Constructs a `ReadableStream` whose `start()` installs `conn.onMessage(cb)`
   — every ACP message from the agent is enqueued into the SDK's read side.
2. Constructs a `WritableStream` whose `write(msg)` calls `conn.send(msg)`
   — every SDK-generated message goes directly out the WS.
3. An interceptor (`tryInterceptSessionUpdate`) filters `session/update`
   notifications before they reach the SDK (to avoid zod-strict dropping).

The `AgentConnection` object is obtained from the in-process
`AgentletServer.getConnection(sessionId)` — no HTTP/WS hop from Huabu's
perspective; it's a direct reference to the server's connection object that
bridges to the agent CLI's real WebSocket.

## 4. Migration Steps (Option A — Keep SDK, Skip Re-init)

### Step 1: Add `seedFromRecord()` to `AcpAgentClient`

Add a method that injects the `initializeResult` (from DataStore) without
calling `initialize()` over the wire:

```typescript
// client.ts — new method
seedFromRecord(initializeResult: AcpInitializeResult): void {
  this._initializeResult = initializeResult;
}
```

This allows callers to use `client.initializeResult` (for `agentSupportsLoadSession`
checks, meta seeding, etc.) without a network round-trip.

### Step 2: Update `ensureAcpSessionInner` in `service.ts`

Replace the current flow:

```typescript
// Current (lines 482-641):
const client = new AcpAgentClient(conn, { canvasId, logger });
await client.initialize(); // ← REMOVE
// ... complex loadSession / newSession       // ← REMOVE
const newResult = await client.newSession({ cwd }); // ← REMOVE
sessionId = newResult.sessionId;
```

With:

```typescript
// New:
const dataStore = server.getDataStore();
const record = await dataStore.getSession(agentSessionId);
if (!record) {
  throw new Error(`Session ${agentSessionId} not found in DataStore`);
}

const client = new AcpAgentClient(conn, { canvasId, logger });
client.seedFromRecord(record.initializeResult as AcpInitializeResult);
sessionId = agentSessionId; // USE the daemon's sessionId directly
```

Key changes:

- **No `client.initialize()`** — capabilities come from DataStore
- **No `client.newSession()` / `client.loadSession()`** — session already exists
- **`sessionId` = `agentSessionId`** (from spawn-orchestrator) — no divergence

### Step 3: Seed session meta from DataStore record

Replace `seedSessionMetaFromResponse(created, newResult, logger)` with seeding
from the DataStore's persisted `initializeResult` + any session/new response
fields that the daemon captured:

```typescript
const initResult = record.initializeResult as AcpInitializeResult;
// initializeResult has: agentCapabilities, agentInfo, instructions
// session/new fields (modes, models, configOptions) should be in DataStore
// if agentlet-server persists them — verify.
seedSessionMetaFromResponse(created, initResult, logger);
```

### Step 4: Remove `loadSession` path

The entire `if (persisted) { ... loadSession ... }` block (lines 517-630) is
no longer needed. The daemon handles session resume/load on its own during
bootstrap. Huabu just reads the resulting session from DataStore.

For server restart recovery:

- When Huabu restarts → the agentlet daemon also restarts (child process)
- Daemon re-bootstraps → does `initialize + session/resume` (or `session/load`)
- Agent/hello → new WS connection registered in server
- Huabu reads fresh `DataStore.getSession()` → has up-to-date record

### Step 5: Keep everything else unchanged

These remain exactly as-is:

- `client.prompt(sessionId, text, onUpdate, signal, onPermission)` — SDK handles
  JSON-RPC correlation, the stream adapter routes messages
- `client.cancel(sessionId)` — same
- `client.setSessionMode/Model/ConfigOption()` — same
- `client.resolvePermission()` — same
- Permission handler, fs handler — same (registered via `createClientHandler()`)
- `streamFromAgentConnection()` — still bridges `AgentConnection` ↔ SDK Stream
- `tryInterceptSessionUpdate()` — still filters before SDK

### Step 6 (Future): Wire EventStore subscription for chat history

For the chat panel to survive page refresh, add an endpoint that replays
events from EventStore. This is INDEPENDENT of Option A and can be done later:

```typescript
const eventStore = server.getEventStore();

// Replay + live (same pattern as host-ws.ts handleSubscribe)
const unsub = eventStore.subscribe(sessionId, (entry) => {
  if (entry.dir === 'agent') handleAgentEvent(entry.event);
});
const history = eventStore.getEventsSince(sessionId, 0);
for (const entry of history) {
  if (entry.dir === 'agent') handleAgentEvent(entry.event);
}
```

This is a separate feature (chat history persistence) — NOT blocking for the
init-skip fix.

### Step 7: Cleanup

- Remove the `agentSupportsLoadSession()` / `loadSession()` / "already loaded"
  retry logic from `ensureAcpSessionInner` (entire block ~115 lines)
- Remove `readAcpSessionRecord()` / `writeAcpSessionRecord()` calls that
  persisted `sessionId` separately (DataStore already has it)
- Keep `AcpAgentClient.initialize()` and `newSession()` methods temporarily
  (in case we need a fallback), but mark `@deprecated`

## 5. What Does NOT Change

- **`AcpAgentClient` class** — kept as-is, just skip calling `initialize()`/
  `newSession()`/`loadSession()` from the caller
- **`streamFromAgentConnection()`** — still bridges `AgentConnection` ↔ SDK
- **`ClientSideConnection` (SDK)** — still provides JSON-RPC correlation,
  inbound request dispatch, permission/fs handlers
- **`tryInterceptSessionUpdate()`** — still filters `session/update` for
  permissive parsing before SDK sees them
- **Agentlet subprocess lifecycle** — `daemon-supervisor.ts` is unchanged
- **Spawn orchestrator** — `spawnOnAgentlet()` / `ensureAgentForThread()`
  — same API, just the sessionId is now used directly by Huabu
- **Translator** — `acpUpdateToStreamEvent()` still converts `session/update`
  payloads to `AgentStreamEvent`
- **Preprocessor** — `ExternalAgentPrompt` building is unchanged
- **Web client** — SSE transport, `useAgentStream`, `chatStore` are unchanged
- **AgentBinding / canvas data model** — stable
- **Auth** — `daemon-auth.ts` unchanged

## 6. Session/Prompt JSON-RPC Shape

The SDK wraps these for us (unchanged behavior), but for reference:

```json
// Host → Agent (via conn.send, wrapped by SDK's prompt())
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

Response via `conn.onMessage()` (SDK resolves the Promise):

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": { "stopReason": "end_turn" }
}
```

`session/update` notifications (intercepted before SDK, dispatched to handlers):

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123",
    "update": { "sessionUpdate": "agent_message_chunk", "content": "Hello!" }
  }
}
```

## 7. ACP SDK Audit — What It Does in Huabu

### SDK class: `ClientSideConnection` from `@agentclientprotocol/sdk`

A bidirectional JSON-RPC 2.0 state machine bridged to `AgentConnection` via
`streamFromAgentConnection()` (ReadableStream ↔ WritableStream adapter).

### Outbound: SDK methods Huabu calls (Client→Agent requests)

| Method                     | Used?               | Where                  |
| -------------------------- | ------------------- | ---------------------- |
| `initialize()`             | Yes — **REDUNDANT** | `service.ts:483`       |
| `newSession()`             | Yes — **REDUNDANT** | `service.ts:637`       |
| `loadSession()`            | Yes — **REDUNDANT** | `service.ts:537`       |
| `prompt()`                 | **Yes — KEEP**      | `service.ts:1191`      |
| `cancel()`                 | **Yes — KEEP**      | `client.ts:488`        |
| `setSessionMode()`         | **Yes — KEEP**      | `threads.route.ts:245` |
| `setSessionModel()`        | **Yes — KEEP**      | `threads.route.ts:285` |
| `setSessionConfigOption()` | **Yes — KEEP**      | `threads.route.ts:327` |
| `resumeSession()`          | No                  |                        |
| `closeSession()`           | No                  |                        |
| `authenticate()`           | No                  |                        |

### Inbound: Agent→Client requests (need JSON-RPC response)

| Agent sends                  | Handler                                      | Complexity                             |
| ---------------------------- | -------------------------------------------- | -------------------------------------- |
| `session/request_permission` | Suspend until UI decides (30s timeout)       | Medium — Promise + pending-map + timer |
| `fs/read_text_file`          | Sandboxed canvas read (`capabilities/fs.ts`) | Low — path validation + readFile       |
| `fs/write_text_file`         | Always reject `-32601`                       | Trivial                                |
| `terminal/*` (5 methods)     | Always reject `-32601`                       | Trivial                                |

### Inbound: Agent→Client notifications (no response)

| Agent sends      | Handler                                                                                 | Note                                      |
| ---------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| `session/update` | **Intercepted BEFORE SDK** by `tryInterceptSessionUpdate()` → `dispatchSessionUpdate()` | SDK's own handler is a dead-code fallback |

### What the SDK provides (value-add to replicate)

1. **Request/response correlation** — tracks `id` → Promise for outbound
   requests (`prompt`, `setSessionMode`, etc.). ~30 lines.
2. **Bidirectional request dispatch** — detects inbound REQUESTS (have `id` +
   `method`) vs NOTIFICATIONS (have `method`, no `id`), calls the right
   handler, and auto-sends the JSON-RPC response. ~50 lines.
3. **Zod schema validation** — validates all messages. Huabu already bypasses
   this for `session/update` (too strict). Lower value than expected.

### What the SDK does that's harmful/unnecessary

1. **Forces re-initialization** — `initialize + session/new` state machine
   that conflicts with the daemon's bootstrap.
2. **Strict zod drops valid messages** — `session/update` with a `null`
   description field gets silently discarded (hence the interceptor bypass).
3. **Stream adapter overhead** — `ReadableStream/WritableStream` wrapping
   around a simple `conn.send()/onMessage()` pair.

### Verdict

The SDK wraps ~80 lines of JSON-RPC plumbing (correlation + dispatch) behind
a moderate abstraction. The **real** problem was the redundant `initialize()` +
`newSession()` calls — not the SDK itself. Since the SDK has NO state machine
guard, we can simply skip those calls and keep the SDK's value-add:

- Request/response correlation
- Bidirectional request dispatch (`fs/read_text_file`, `session/request_permission`)
- AbortController lifecycle management
- Type-safe method wrappers (`.prompt()`, `.cancel()`, etc.)

## 8. Risk Assessment

| Risk                                                                | Mitigation                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Agent rejects `prompt` without prior `initialize` on the same conn  | The daemon already initialized on this conn's STDIO channel; the WS relay is a transparent passthrough |
| `clientCapabilities` not advertised (agent doesn't know about `fs`) | Daemon bootstrap uses `{}` capabilities → agent may not request `fs/*`. Verify in testing.             |
| DataStore `getSession()` returns stale/missing record               | Add a retry-wait after spawn (DataStore write is async after `agent/hello`)                            |
| Session meta shape from DataStore differs from `session/new` result | Verify `SessionRecord` fields match what `seedSessionMetaFromResponse()` expects                       |
| `loadSession` removal breaks server-restart recovery                | Daemon re-bootstrap handles recovery; test with server restart while agent is alive                    |

## 9. Effort Estimate

| Step                                            | Effort       |
| ----------------------------------------------- | ------------ |
| 1. Add `seedFromRecord()` to `AcpAgentClient`   | 15 min       |
| 2. Update `ensureAcpSessionInner`               | 1-2 hours    |
| 3. Seed meta from DataStore                     | 30 min       |
| 4. Remove `loadSession` path                    | 30 min       |
| 5. Verify all entry points still compile/work   | 1 hour       |
| 6. EventStore subscription for history (future) | 2-3 hours    |
| 7. Cleanup deprecated code                      | 30 min       |
| **Total (core fix)**                            | **~3-5 hrs** |
| **Total (including history feature)**           | **~6-8 hrs** |

## 10. Open Questions

1. **`clientCapabilities` for `fs/read_text_file`**: The daemon's bootstrap
   sends `clientCapabilities: {}` (empty) to the agent. If the agent uses this
   to decide whether it CAN request `fs/read_text_file`, it may never ask.
   Verify: does Copilot CLI agent check capabilities before requesting fs reads?
   If yes, we may need the daemon to pass `{ fs: { readTextFile: true } }` in
   its bootstrap — this is an agentlet-level change, not a Huabu change.

2. **DataStore timing**: After `spawnOnAgentlet()` returns with `{sessionId}`,
   is the `DataStore.getSession(sessionId)` record guaranteed to exist? The
   spawn response means `agent/hello` was processed, which calls
   `persistSessionRecord()` — but that's async. May need a small poll/wait.

3. **Orphan updates for initial commands**: When the agent sends
   `available_commands_update` notification immediately after `session/new`
   (during daemon bootstrap), those go through the WS relay. If Huabu hasn't
   yet constructed the `AcpAgentClient` and installed its `onMessage` handler,
   those notifications are lost. The existing orphan buffer handles this for the
   current flow — verify it still works when we skip `initialize()`/`newSession()`.

4. **Option B migration path**: Once Option A is stable, should we still pursue
   removing the SDK? The value proposition is smaller now (saves ~3KB bundle,
   removes one abstraction layer). May not be worth the risk if Option A works
   cleanly.
