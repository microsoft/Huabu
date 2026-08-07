# Agentlet Protocol Upgrade Plan

> Upgrade Huabu's embedded agentlet from the old `bridge/daemon` protocol
> to the latest `agentlet/hello` + `agent/hello` split protocol.
>
> Status: **Superseded** · Last updated: 2026-07-14
>
> Superseded by [`agenetes-agentlet-gateway-consolidation.md`](../proposals/agenetes-agentlet-gateway-consolidation.md), which shipped the split hello protocol as part of the daemon/Gateway ownership migration.

---

## 1. What Changed Upstream

The agentlet repo (`hai-team/agentlet`) has 47 new commits since our last
subtree sync (`0f4a9ed1`). The changes are primarily a **protocol rename and
restructure** — the relay/bridge/spawn mechanics are the same, but the
naming, identity model, and data persistence layer have been overhauled.

### 1.1 Protocol Rename

| Old (current Huabu)           | New (upstream HEAD)                               | Notes                                           |
| ----------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `bridge/hello`                | `agentlet/hello` + `agent/hello`                  | Split into two handshakes on two WS connections |
| `bridge/agent_exited`         | `agent/exited`                                    | entity/verb naming                              |
| `bridge/agent_restarted`      | `agent/restarted`                                 |                                                 |
| `bridge/goodbye`              | `agent/goodbye`                                   |                                                 |
| `bridge/buffer_overflow`      | `agent/overflow`                                  |                                                 |
| `bridge/replay`               | `server/replay`                                   |                                                 |
| `bridge/ping` / `bridge/pong` | `server/ping` / `agent/pong`                      |                                                 |
| `bridge/shutdown`             | `server/shutdown`                                 |                                                 |
| `bridge/spawn` (daemon)       | `server/spawn`                                    |                                                 |
| `bridge/stop` (daemon)        | `server/stop`                                     |                                                 |
| `bridge/list` (daemon)        | `server/list`                                     |                                                 |
| _(N/A)_                       | `agentlet/hello`                                  | New: adapter registration handshake             |
| _(N/A)_                       | `agent/suspended`                                 | New: idle timeout notification                  |
| _(N/A)_                       | `host/send`, `host/subscribe`, `host/unsubscribe` | New: multiplexed host channel                   |
| _(N/A)_                       | `server/event`, `server/replayed`                 | New: event persistence + replay                 |

### 1.2 Identity Model

| Old                                          | New                                   | Change                                          |
| -------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| `agentId` = `hostname:exe:cwd:uuid` (random) | **Removed** from protocol             | No longer a routing key                         |
| `daemonId`                                   | `agentletId` = `hostname:agentlet`    | Adapter identity                                |
| `sessionId` (secondary)                      | `sessionId` (**primary routing key**) | Now the only key used for message dispatch      |
| _(N/A)_                                      | `displayName`                         | UI-only, editable, replaces agentId for display |

### 1.3 Connection Model

Old: one WS connection per daemon, bridge messages multiplexed.

New: **two WS connection types** on the same `/api/bridge` endpoint, distinguished by `?role=`:

```
WS /api/bridge?role=agentlet&id=<agentletId>  →  agentlet/hello  →  control channel
WS /api/bridge?role=session&id=<sessionId>    →  agent/hello     →  per-session ACP relay
```

### 1.4 Data Persistence (server-side)

Old: in-memory connection map only.

New: three-layer model:

- **SQLite** (`sessions.db`) — `agentlets` + `sessions` tables (durable, survives restart)
- **In-memory** — live WS handles only (slim `ConnectionHandle`)
- **JSONL** — per-session event logs (`events/<sessionId>.jsonl`) for replay

### 1.5 Key Type Changes

Old `bridge-messages.ts` (deleted) → New `messages.ts`:

```typescript
// New types
SessionProfile; // replaces old bridge hello payload
SessionSpec; // replaces old DaemonSpawnParams.command/cwd
AgentletProfile; // new: adapter profile for agentlet/hello
AgentletHelloParams / AgentletHelloResult;
AgentHelloParams / AgentHelloResult;
SpawnParams; // now includes appId + sessionSpec
AgentSuspendedParams; // new: idle timeout
LifecycleEvent; // typed union of all lifecycle events
```

Old `BridgeMethods` / `BridgeErrorCodes` → New `AgentletMethods` / `AgentMethods` / `ServerMethods` / `HostMethods` / `ErrorCodes`.

### 1.6 Server API Changes

| Old                           | New                                         |
| ----------------------------- | ------------------------------------------- |
| `GET /api/agents`             | `GET /api/sessions` (deprecated alias kept) |
| `GET /api/agents/:id`         | `GET /api/sessions/:id`                     |
| _(N/A)_                       | `GET /api/agentlets`                        |
| _(N/A)_                       | `GET /api/agentlets/:id`                    |
| `POST /api/daemons/:id/spawn` | `POST /api/agentlets/:id/spawn`             |
| `POST /api/daemons/:id/stop`  | `POST /api/agentlets/:id/stop`              |
| _(N/A)_                       | `GET /api/agentlets/:id/sessions`           |
| _(N/A)_                       | `WS /api/host` (multiplexed host channel)   |

---

## 2. Impact on Huabu

Huabu embeds `@agentlet/server` in-process (no standalone mode) and uses
the **TypeScript API** directly (`AgentletServer`, `AgentConnection`). It
does **not** use the REST or host-WS endpoints — those are standalone-only.

This means most of the new REST/WS features are irrelevant to us. The
actual impact is the **embedded library API surface change**: how
`AgentletServer` is constructed, how connections are obtained, and what
`AgentConnection` looks like.

### 2.1 Files That Need Changes

#### Server-side (`apps/server/src/modules/agent/acp/`)

| File                    | What changes                                                                                                                                                                                                                                                   | Scope        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `server-mount.ts`       | `AgentletServer` constructor options may have new fields (`storeDir`, `init()`). Connection lookup changes from `getConnection(agentId)` to `getConnection(sessionId)`.                                                                                        | Small        |
| `daemon-supervisor.ts`  | Rename to `agentlet-supervisor.ts`. The child process is now `agentlet` (no `daemon` subcommand — idle mode is just `agentlet` without `--agent`). Token passing and restart logic stay the same.                                                              | Small–Medium |
| `spawn-orchestrator.ts` | The core consumer of spawn/stop/list. Old: `bridge/spawn` via daemon WS. New: `server/spawn` with `{ appId, sessionSpec }`. Replace `daemonId` → `agentletId`, `agentId` → `sessionId`. SpawnResult now returns `{ sessionId, pid }` instead of `{ agentId }`. | Medium       |
| `session-registry.ts`   | Replace `agentletAgentId` key with `sessionId`. Drop `agentId` from entry shape.                                                                                                                                                                               | Small        |
| `session-store.ts`      | On-disk records: rename `agentletAgentId` field to `sessionId`. Add migration for existing v3 records.                                                                                                                                                         | Small        |
| `daemon.route.ts`       | Rename to `agentlet.route.ts`. `GET /api/acp/daemon` → `GET /api/acp/agentlet`. Response shape: `AcpDaemonStatus` → `AcpAgentletStatus`.                                                                                                                       | Small        |
| `daemon-auth.ts`        | Rename to `agentlet-auth.ts`. Logic unchanged (token mint/rotate).                                                                                                                                                                                             | Trivial      |
| `profiles.route.ts`     | List response includes `daemon` field → rename to `agentlet`.                                                                                                                                                                                                  | Trivial      |
| `service.ts`            | Uses `AgentConnection.send()` / `onMessage()`. The API shape is the same, but the connection is now looked up by `sessionId`.                                                                                                                                  | Small        |
| `client.ts`             | No protocol-level changes — this speaks ACP (`session/prompt`, etc.), not bridge protocol.                                                                                                                                                                     | None         |
| `translator.ts`         | No changes — translates ACP `session/update`, not bridge messages.                                                                                                                                                                                             | None         |
| `preprocessor.ts`       | No changes.                                                                                                                                                                                                                                                    | None         |

#### Shared types (`packages/shared/src/types/api/acp.ts`)

| Change                                                    | Details                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| `AcpDaemonStatus` → `AcpAgentletStatus`                   | Rename `daemonId` → `agentletId`, update JSDoc                  |
| `AcpProfilesListResponse`                                 | `daemon` field → `agentlet` field                               |
| `AcpDaemonStatusResponse` → `AcpAgentletStatusResponse`   | Type alias rename                                               |
| `AcpDaemonRestartResponse` → `AcpAgentletRestartResponse` | Type alias rename                                               |
| JSDoc comments                                            | Remove references to "bridge/hello", "daemon" where appropriate |

#### Web client (`apps/web/src/`)

| File                                  | What changes                                          | Scope   |
| ------------------------------------- | ----------------------------------------------------- | ------- |
| `store/acpProfilesStore.ts`           | `daemon` field → `agentlet` in fetched data shape     | Trivial |
| `api/acp.ts`                          | Endpoint URL: `/api/acp/daemon` → `/api/acp/agentlet` | Trivial |
| `hooks/useAcpProfiles.ts`             | Passthrough — follows store rename                    | Trivial |
| `components/Panels/ChatPanel/`        | Display "agentlet" instead of "daemon" in status UI   | Trivial |
| `docs/sections/ai/ExternalAgents.tsx` | Update help text                                      | Trivial |

#### Question node / binding model

**No changes needed.** `AgentBinding` (`{ kind: 'external', alias, profileId }`)
is a Huabu-level concept that maps profiles → agentlet sessions at
runtime. The binding does not store `agentId` or `sessionId` — those are
ephemeral and resolved at dispatch time by the spawn orchestrator. This
abstraction layer insulates the canvas data model from the protocol change.

---

## 3. Migration Steps

### Step 0 — Subtree Pull

```bash
git subtree pull --prefix=external/agentlet agentlet-upstream main --squash
```

This brings in all 47 upstream commits as a single squash merge. Build the
subtree to verify it compiles:

```bash
cd external/agentlet && pnpm install && pnpm run build
```

### Step 1 — Protocol Type Alignment (shared package)

Update `packages/shared/src/types/api/acp.ts`:

- Rename `AcpDaemonStatus` → `AcpAgentletStatus` (keep old as deprecated alias)
- Rename `daemonId` → `agentletId`
- Update `AcpProfilesListResponse.daemon` → `.agentlet`
- Update JSDoc to reference new protocol methods
- Add temporary compat aliases if needed for incremental migration

### Step 2 — Server-Side Rename & API Update

1. Rename files:
   - `daemon-supervisor.ts` → `agentlet-supervisor.ts`
   - `daemon.route.ts` → `agentlet.route.ts`
   - `daemon-auth.ts` → `agentlet-auth.ts`

2. Update `agentlet-supervisor.ts`:
   - Remove `daemon` subcommand from spawn args (idle mode = no `--agent`)
   - Adjust child process CLI flags if needed
   - Update status reporting to use `agentletId`

3. Update `spawn-orchestrator.ts`:
   - `spawnOnDaemon()` → `spawnOnAgentlet()`
   - Spawn params: `{ appId, sessionSpec: { command, cwd } }` instead of `DaemonSpawnParams`
   - Result handling: `{ sessionId, pid }` instead of `{ agentId }`
   - Connection lookup: by `sessionId`

4. Update `session-registry.ts` + `session-store.ts`:
   - Replace `agentletAgentId` with `sessionId` throughout
   - Add schema migration for persisted records

5. Update `server-mount.ts`:
   - Adapt to new `AgentletServer` constructor (check if `storeDir` / `init()` needed)
   - Update connection lookup API

6. Update routes:
   - `/api/acp/daemon` → `/api/acp/agentlet`
   - Profile list response shape

### Step 3 — Web Client Updates

- Update `api/acp.ts` endpoint URLs
- Update `acpProfilesStore.ts` response shape
- Update any UI strings that say "daemon" → "agentlet"

### Step 4 — Verify & Test

- `pnpm run build` — full monorepo build
- `pnpm run lint:fix && pnpm run format`
- Run existing ACP tests: `session-store.test.ts`, `client.test.ts`, `daemon-auth.test.ts`, etc.
- Manual smoke test: connect an external agent, run a question node

---

## 4. What We Do NOT Need to Change

- **`client.ts`** — speaks pure ACP (`session/prompt`, `session/update`), not bridge protocol
- **`translator.ts`** — translates ACP session updates, unaffected
- **`preprocessor.ts`** — prompt shaping, unaffected
- **`AgentBinding`** model — profile-based, doesn't store protocol-level IDs
- **Question node data model** — `agentBinding` is stable
- **Chat store bindings** — profile-level, not protocol-level
- **Host channel / event replay** — Huabu uses embedded mode (in-process API), doesn't need the new `/api/host` WS or JSONL replay. Our own SSE layer (`translator.ts`) handles streaming.

---

## 5. Risk Assessment

| Risk                                                    | Likelihood | Mitigation                                                                                      |
| ------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `AgentletServer` constructor API breaking change        | Medium     | Check upstream `gateway-types.ts` for new required options                                      |
| `AgentConnection` shape change (fields removed/renamed) | Medium     | Compare old vs new `gateway-types.ts`; our usage is narrow (`send()`, `onMessage()`, `session`) |
| Subtree merge conflicts in `server-mount.ts`            | Low        | We customized minimally; resolve manually                                                       |
| Session store migration breaks existing data            | Low        | Add v3→v4 migration; old `agentletAgentId` → `sessionId`                                        |
| Daemon CLI args change breaks supervisor                | Medium     | Verify `agentlet` CLI (no `daemon` subcommand, just omit `--agent`)                             |

---

## 6. Estimated Effort

| Step                                           | Effort      |
| ---------------------------------------------- | ----------- |
| Subtree pull + build verification              | 30 min      |
| Shared type renames                            | 1 hr        |
| Server-side file renames + orchestrator update | 2–3 hr      |
| Web client updates                             | 30 min      |
| Testing + smoke test                           | 1 hr        |
| **Total**                                      | **~5–6 hr** |

The migration is primarily a **rename + API alignment** — no architectural
changes to Huabu's ACP integration. The session lifecycle, preprocessor,
translator, and capability system are all unaffected.
