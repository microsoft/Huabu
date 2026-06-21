# Development TODO

Tracking spec-code gaps and deferred work items.

## Active — Data Governance (Phases completed)

### ✅ Phase 1: DataStore with agentlets table

Added `DataStore` class (renamed from `SessionStore`) with both `sessions` and `agentlets` tables in SQLite. `saveAgentlet()` called on `agentlet/hello`. REST `/api/agentlets` reads from persistent store.

### ✅ Phase 2: Slim connections + token signature

Removed `sessionProfile`, `agentletProfile`, `token`, `agentId` from `AgentConnection` interface. Added `agentletId` and `role`. Profiles stored as JSON in SQLite. Token replaced with `sha256(token)` as `owner` identity. REST auth uses `tokenSignature()` for owner-based scoping.

### ✅ Phase 3: Demote agentId from routing

`agent-ws.ts` rekeyed from `agentId` to `sessionId`. All routing uses sessionId/agentletId. `agentId` is display-only in DataStore and protocol messages.

## Deferred — Authentication Refactor

### Auth: `Authorization` header instead of `?token=`

Spec says `Authorization: Bearer <token>` header for CLI clients, `?ticket=` for browser clients. Code currently uses `?token=` query param everywhere. Token in query is insecure (leaks in logs/referrer).

Files: `server.ts:145`, `host-ws.ts:50-55`, `agent-ws.ts:47`, `ws-client.ts:77-80`, `daemon.ts:84-89`.

### Auth: Browser ticket mechanism

Browser `WebSocket` API cannot set custom headers. Implement a short-lived single-use ticket flow:

1. REST endpoint to exchange a Bearer token for a one-time ticket
2. Browser passes `?ticket=<ticket>` on WS upgrade
3. Server validates and consumes the ticket (single-use)

No code exists yet. Spec defined in `openapi.yaml:493-500` and `asyncapi.yaml:51-57`.

### Auth: Host WS channel authentication

`host-ws.ts:50-55` accepts any WebSocket upgrade without authentication. Should validate token/ticket on upgrade.

## Deferred — Reconnection

### Reconnection: Agentlet control channel

Current reconnection logic (`ws-client.ts`, `daemon.ts`) always uses `agent/hello` on reconnect. With the new protocol, agentlet control channel reconnection should use `agentlet/hello` (same `agentletId`).

### Reconnection: Per-session WS recovery

When an agent-session WS drops, the agentlet should reconnect with `agent/hello` (same `sessionId`). Need to ensure the server recognizes this as a reconnection and replays buffered messages. Currently partially implemented but not fully tested with the new per-session WS model.

## Deferred — Status Sync

### Status sync: Server lifecycle updates

`agent/exited` and `agent/suspended` notifications don't update session status in `SessionStore`. They only fire lifecycle events.

- `agent/exited` → set session status to `closed`
- `agent/suspended` → set session status to `suspended`

### Status sync: Stale session cleanup on restart

Server restart leaves stale `active`/`starting` sessions in the DB. `SessionStore.init()` should mark them as `closed`.

### Status sync: UI status display

UI `SessionPanel.vue` should leverage both `connected` boolean and `status` field for richer status display (e.g., show "suspended" vs "disconnected" vs "closed").

## Deferred — Code Cleanup

### ✅ Rename: `Bridge` / `Daemon` → unified `Agentlet` class

Merged `bridge.ts` (`Bridge` class) and `daemon.ts` (`Daemon` class) into a single `agentlet.ts` with one `Agentlet` class. CLI types unified into `AgentletOptions`. Mode is determined by whether `--agent` is provided.

Note: The protocol field `bridge: { name, version }` in `AgentletProfile`/`SessionProfile` and the WS endpoint `/api/bridge` are **intentionally** named "bridge" — don't rename those.

### Remove dead UI components

`AgentSelector.vue`, `AgentletPanel.vue`, `DaemonPanel.vue`, `daemons.ts` store — still on disk but no longer imported. Safe to delete.
