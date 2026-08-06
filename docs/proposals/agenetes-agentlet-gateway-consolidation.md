# Agenetes Agentlet Gateway Consolidation

> Absorb the host-side agentlet relay into Agenetes, retire the standalone agentlet-server control plane, and make Agenetes the sole owner of durable workload and conversation state.
>
> Status: **Shipped** · Last updated: 2026-07-14

---

## 1. Context

Agentlet currently contains two products with overlapping responsibilities:

1. The agentlet daemon is a remotely deployable execution adapter that launches ACP agents, bootstraps sessions, and relays protocol traffic.
2. `@agentlet/server` is a standalone control plane with REST APIs, host and raw-agent WebSockets, a built-in UI, token administration, SQLite session persistence, and JSONL event persistence.

Huabu does not use the standalone product boundary directly. Its only programmatic consumer of `@agentlet/server` is `@agenetes/agentlet-host`, which embeds the server so the Agenetes ACP driver can reach agentlet-managed processes.

Agenetes now owns durable WorkloadSpecs, thread records, ACP session state, Tier-1 events, Tier-2 turns, recovery, and service invocation. Keeping agentlet-server's SessionStore and EventStore creates a second control plane with duplicated identity, persistence, replay, and lifecycle semantics.

## 2. Decision

Agentlet is no longer an independent control plane. The standalone `agentlet-server` binary and the `@agentlet/server` package are retired without a production compatibility layer.

Agenetes absorbs the host-side relay as `@agenetes/agentlet-gateway`. The gateway maintains the existing ephemeral connection, reconnect, and outbound-buffer behavior while all durable workload, session, event, deployment, and setup state belongs to Agenetes.

Agentlet remains independently deployable on execution machines as a daemon and retains its daemon-mode wire protocol, ACP process bootstrap, live process management, and Agent Team execution tools.

## 3. Goals

1. Establish Agenetes as the only durable control plane for agentlet-managed workloads.
2. Remove duplicate Agentlet SessionStore and EventStore persistence.
3. Support explicit multi-daemon placement by stable `agentletId`.
4. Preserve current daemon-mode transport and spawn behavior while changing ownership.
5. Prevent ephemeral spawn environment values from being persisted by the relay layer.
6. Return ACP bootstrap metadata directly to Agenetes instead of requiring database lookups.
7. Keep WebSocket and host-framework dependencies outside `@agenetes/runtime`.

## 4. Non-goals

This proposal does not remove the agentlet daemon or merge it into the Agenetes server process. Remote machines still run agentlet as the execution-plane daemon.

This proposal does not move ACP-native session persistence into agentlet. Agenetes stores the native session identifier and asks the daemon to resume or load it through the ACP agent when realizing a workload.

This proposal does not make the gateway durable. Live sockets, pending RPCs, reconnect buffers, child-process observations, and setup operations remain ephemeral.

The first version does not redesign daemon-mode transport reliability, add sequence acknowledgements or message deduplication, or make spawn an atomic session-readiness operation. Those behavior changes belong to a future reliability backlog.

This proposal does not preserve the standalone agentlet REST API, built-in UI, MCP composition mode, token administration API, host WebSocket, raw-agent WebSocket, or `agentlet --agent` direct bridge mode as supported production surfaces.

The first version does not add enrollment tokens, certificates, PKI, runtime credential rotation, or a credential administration API. The supervised local daemon retains its host-injected process-lifetime token; future remote daemon configuration uses manually configured long-lived tokens.

This proposal does not add Agent Team scan/setup/validate protocol operations. It establishes the multi-daemon Gateway required by [`managed-agent-teams.md`](../proposals/managed-agent-teams.md); that proposal owns the later Agent Team control methods and UI.

## 5. Target ownership

| Component                    | Responsibility                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agentlet/protocol`         | Agentlet daemon/gateway wire types, handshakes, control operations, and existing replay notifications.                                                                      |
| agentlet daemon              | ACP process bootstrap, child-process lifecycle, stdio relay, existing reconnect/buffer behavior, and Agent Team scan/setup/cancel/validate execution.                       |
| `@agentlet/agent-team`       | Manifest parsing and daemon-side Agent Team setup/validation primitives.                                                                                                    |
| `@agenetes/agentlet-gateway` | Authentication, WebSocket upgrades, live daemon/session connection registries, pending RPC correlation, explicit-daemon routing, and existing gateway-to-session buffering. |
| `@agenetes/acp-driver`       | ACP session realization, protocol translation, native session metadata, and AgentHandle behavior.                                                                           |
| `@agenetes/agenetes`         | Durable WorkloadSpecs, thread records, Tier-1 events, Tier-2 turns, state snapshots, recovery, and live-handle lifecycle.                                                   |
| Host application             | Gateway mounting, authentication and authorization adapters, secure credential/config ports, HTTP projection, and deployment-specific reachback integration.                |

## 6. Gateway invariants

### 6.1 No durable gateway store

The gateway has no SQLite SessionStore, JSONL EventStore, or equivalent persistent replay database.

Its state is limited to:

- current daemon and agent-session connections
- pending control RPC requests
- bounded gateway-to-session outbound buffers
- bounded session-to-gateway messages received before the ACP client attaches
- subscriptions and lifecycle callbacks

After a full gateway process restart, Agenetes recovers workloads from its durable thread state and asks the selected daemon to realize the required ACP session.

### 6.2 Explicit placement

Every daemon-directed operation carries an explicit stable `agentletId`. The gateway never selects the first connected daemon.

Connection registries and ACP session caches are scoped by agentlet identity. A control connection disconnect or replacement affects only control operations for that daemon; existing session connections remain usable and are invalidated only when their own sockets disconnect. No event for one daemon invalidates another daemon's connections or caches.

In the first version, `agentletId` is the daemon's machine name. For Huabu's supervised local daemon, the host reads `os.hostname()` at startup and passes the same value to the Gateway and the daemon's `--agentlet-id` option. No additional local identity file is introduced.

For backward compatibility, persisted ACP WorkloadSpecs created before placement was introduced may omit `agentletId`. The ACP composition resolves only those legacy specs to the host-injected supervised local daemon ID. This is a read-time compatibility rule: it does not rewrite the durable WorkloadSpec and never selects from the set of currently connected daemons.

Every newly compiled ACP WorkloadSpec includes an explicit `agentletId`. A missing ID is therefore accepted only when reading a legacy record, not when creating a new workload.

Changing the machine name, including changing the supervised host's OS hostname, creates a new execution node identity. Existing roots, deployments, and explicit workload bindings remain attached to the old identity and become unavailable rather than migrating implicitly.

Huabu's supervised local daemon uses the existing process-lifetime connection token generated by the host and injected into its child process. The host and daemon restart together, so this token does not require persistence.

Future remote daemons each use their own long-lived token. The operator manually configures the same `{ machineName, token }` pair on the remote daemon and the Agenetes host.

The gateway authenticates both the daemon control WebSocket and every session WebSocket independently through a host-injected `authenticateAgentlet(machineName, token)` port. A credential may claim only its configured machine name, and the claimed name must match `sessionProfile.agentletId` on a session hello. A session connection does not require its daemon's control socket to be online.

The gateway does not persist credentials. The supervised local token remains host-process state; Huabu stores future remote daemon tokens through its SecretStore-backed host adapter.

Remote token changes and revocation are startup-time operations in the first version that supports remote configuration. After changing configuration on both sides, the operator restarts the Gateway host and the corresponding daemon. There is no runtime rotation notification or connection-eviction API in this migration.

Registering a live duplicate machine name with the configured credential replaces the old control socket as a reconnect without closing that machine's session sockets. A duplicate machine name using a different credential is rejected.

### 6.3 Connection topology and session identity

The first version retains the current two-level connection topology to limit migration risk:

- one control WebSocket per agentlet daemon
- one session WebSocket per live ACP session

The gateway keys a session connection by `(agentletId, nativeAcpSessionId)`. Native ACP session IDs therefore need to be unique only within one daemon.

Agenetes `ThreadIdentity` remains a durable control-plane identity and is not part of the session WebSocket identity. Agenetes owns the binding from a thread to its placed daemon and native ACP session.

Both connection types use the credential bound to the claimed daemon machine name, but their connection lifecycles remain independent.

### 6.4 Preserve current reconnect and buffer behavior

The consolidation preserves current transport behavior rather than introducing a new reliability contract:

- `AgentConnectionImpl` retains its bounded gateway-to-session outbound buffer and `server/replay` flush on a matching session reconnect.
- Daemon-spawned `ManagedAgent` session connections retain their current behavior; this migration does not add transparent reconnect where none exists today.
- The daemon control connection retains its current exponential-backoff reconnect.
- Agenetes remains responsible for durable thread recovery when the existing transport behavior cannot preserve a live session.

The Gateway adds no durable replay store, end-to-end sequence acknowledgement, exactly-once delivery, or cross-restart message buffer. Removing the agentlet EventStore therefore does not imply a replacement transport protocol in this migration.

Future work may simplify or strengthen these partial reconnect paths after the ownership migration is stable.

The current EventStore also masks a short bootstrap race: agents may emit `session/update` notifications after session hello but before the ACP driver attaches its message handler. To preserve behavior without durable raw-event storage, each live session connection holds up to 1,000 inbound messages before the first ACP handler attaches. The first handler drains that buffer once in arrival order and then receives live messages directly. As with the existing daemon early-message buffer, overflow drops the oldest message and emits a warning without terminating the session.

### 6.5 Ephemeral spawn environment

Spawn environment values are runtime-only inputs. They are transmitted to the selected daemon for process creation but are not written into a gateway SessionStore, durable WorkloadSpec, prepared workspace, or package `.env`.

Agenetes resolves current environment values through injected host config and secret ports whenever it needs to spawn a process.

### 6.6 Preserve spawn-then-wait readiness

The first version preserves the current `server/spawn` timing:

```text
spawn request
  -> daemon starts ACP process
  -> initialize + new/resume/load session
  -> daemon initiates session WebSocket connection
  -> daemon returns { nativeSessionId, pid }
  -> Gateway/ACP driver waits for the session connection
```

The authenticated session hello carries the complete session profile, including initialize/capability results and resume/load support. The Gateway stores that profile only on the live session connection.

The ACP driver keeps its existing bounded wait for the corresponding `(agentletId, nativeAcpSessionId)` connection, then reads bootstrap metadata from the live connection and drains the pre-attach inbound buffer instead of reading DataStore or replaying EventStore.

Making spawn wait atomically for session readiness, and unifying all timeout and teardown paths around that operation, are deferred reliability improvements rather than migration requirements.

## 7. Removed surfaces

The consolidation removes:

- the `agentlet-server` executable
- `@agentlet/server`
- standalone REST session/agentlet/spawn/stop APIs
- standalone host WebSocket
- standalone raw per-agent ACP WebSocket
- built-in agentlet web UI
- standalone token/admin APIs
- standalone MCP composition mode
- `agentlet --agent` direct bridge mode and its bridge-only reconnect buffer
- agentlet SQLite session persistence
- agentlet JSONL event persistence

Standalone development and protocol testing use an Agenetes integration harness rather than a production relay server.

Existing Huabu-owned `<dataDir>/agentlet/sessions.db` and `<dataDir>/agentlet/events/` data remains in place after upgrade but is never read or migrated by the Gateway. Upgrade documentation identifies these inert paths and explains how to remove them manually. Huabu does not inspect or modify storage created by independently deployed standalone agentlet-server instances.

## 8. Feasibility assessment

The migration is feasible with a contained blast radius:

- Huabu reaches `@agentlet/server` only through the Agenetes agentlet-host/ACP path, so there is one production integration to replace.
- The daemon already performs ACP bootstrap and reports session metadata in `agent/hello`; the migration changes where the host retains that metadata, not the bootstrap protocol.
- Agenetes already persists complete driver-specific WorkloadSpecs, session state snapshots, Tier-1 events, and Tier-2 turns, so explicit daemon placement and durable recovery do not require another persistence subsystem.
- Preserving current reconnect/buffer and spawn-then-wait behavior avoids a daemon lifecycle rewrite.

The primary implementation risks are:

1. Losing bootstrap `session/update` notifications when EventStore is removed. The bounded inbound pre-attach buffer is a required migration mechanism.
2. Accidentally falling back to the first connected daemon. New ACP specs and every spawn/cache path require explicit placement; only legacy persisted specs may use the host-injected supervised local daemon ID.
3. Cascading a control disconnect or reconnect into otherwise healthy session connections. Control and session registries must be keyed by daemon but lifecycled independently.
4. Breaking the repository between package moves. The Gateway must be added and adopted before the agentlet server package is deleted.

With behavior changes excluded, the expected implementation size is approximately two to three engineer-weeks, including characterization and cross-restart tests.

## 9. Integration harness

Gateway tests use an in-process HTTP/WebSocket test host mounting the real `@agenetes/agentlet-gateway`.

Deterministic protocol tests use lightweight fake daemon and session WebSocket clients to exercise authentication, duplicate identity, composite session keys, buffering, reconnect, and multi-daemon isolation.

End-to-end spawn and recovery tests additionally launch the real agentlet daemon against the in-process Gateway and use a mock ACP subprocess. This harness is test-only and does not expose standalone production REST, UI, or relay-server surfaces.

## 10. Executable migration tasks

The migration is intentionally additive before it becomes subtractive: build and switch to the Agenetes Gateway first, then delete `@agentlet/server`.

Changes under `external/agentlet/` are always committed separately from Agenetes and Huabu changes so the agentlet subtree can be pushed upstream cleanly.

### G0 — Add behavior-characterization tests

| Item       | Detail                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status     | ✅ Complete.                                                                                                                                                                                           |
| Scope      | Current `@agentlet/server`, agentlet daemon, and ACP driver tests.                                                                                                                                     |
| Work       | Lock down control/session hello, spawn-then-wait, gateway-to-session outbound buffering, reconnect flush, bootstrap `session/update` delivery, and current daemon-spawned-session disconnect behavior. |
| Dependency | None.                                                                                                                                                                                                  |
| Validation | Tests pass against the current implementation before Gateway extraction.                                                                                                                               |
| Commit     | Agentlet tests and Agenetes tests remain separate commits by subtree.                                                                                                                                  |

### G1a — Register the Gateway workspace and build order

| Item       | Detail                                                                                                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | ✅ Complete.                                                                                                                                                                                                                                                                 |
| Scope      | Root `pnpm-workspace.yaml` and `package.json`.                                                                                                                                                                                                                               |
| Work       | Register `external/agenetes/packages/agentlet-gateway` as a workspace package and add it to `build:agenetes` before `agentlet-host`. This is required when G1 lands because `@agenetes/*` packages resolve types from gitignored `dist/`; registration cannot wait until G8. |
| Dependency | G0.                                                                                                                                                                                                                                                                          |
| Validation | The normal workspace filter resolves the new package and `build:agenetes` builds it before downstream consumers.                                                                                                                                                             |
| Commit     | Huabu-only enabling commit.                                                                                                                                                                                                                                                  |

### G1 — Create the durably stateless Agenetes Gateway

| Item               | Detail                                                                                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | ✅ Complete.                                                                                                                                                                                                                                                                                                |
| Scope              | New `external/agenetes/packages/agentlet-gateway/`.                                                                                                                                                                                                                                                         |
| Work               | Move WebSocket handshake, live connection registry, pending RPC correlation, spawn/stop/list/send-resource routing, lifecycle callbacks, and current outbound buffer/reconnect behavior from `@agentlet/server`; omit DataStore, EventStore, REST, host/raw-agent WebSockets, UI, and token administration. |
| Required additions | Composite session key `(agentletId, nativeAcpSessionId)`, live `sessionProfile` accessor, bounded drain-once inbound pre-attach buffer, and host-injected `authenticateAgentlet(machineName, token)`.                                                                                                       |
| Dependency         | G1a.                                                                                                                                                                                                                                                                                                        |
| Validation         | Unit tests cover two simultaneous daemons, same-credential control replacement, different-credential duplicate rejection, independent control/session disconnects, outbound reconnect flush, inbound pre-attach drain order, and FIFO drop-oldest behavior with an overflow warning.                        |
| Commit             | Agenetes-only commit.                                                                                                                                                                                                                                                                                       |

### G2 — Make daemon machine identity explicit

| Item       | Detail                                                                                                                                                                                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | ✅ Complete.                                                                                                                                                                                                                                                                                                                            |
| Scope      | `external/agentlet/packages/local/` and the corresponding Agentlet protocol documentation.                                                                                                                                                                                                                                              |
| Work       | Use the daemon's machine name as `agentletId` on control and session hello, accept an explicit `--agentlet-id` from the supervising host, keep the existing token and daemon reconnect behavior, and remove direct bridge mode. G3 derives Huabu's supervised local ID from `os.hostname()` and injects the same value into both sides. |
| Dependency | G0; may proceed in parallel with G1.                                                                                                                                                                                                                                                                                                    |
| Validation | Control and session connections report the same machine name; changing the supervised host's hostname produces a new execution-node identity; existing daemon tests pass.                                                                                                                                                               |
| Commit     | Agentlet-subtree-only commit.                                                                                                                                                                                                                                                                                                           |

### G3 — Mount Gateway through the existing host package

| Item       | Detail                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status     | ✅ Complete.                                                                                                                                                                                                                                                                                                                                                                               |
| Scope      | `external/agenetes/packages/agentlet-host/` plus the ACP driver's transport adaptation.                                                                                                                                                                                                                                                                                                    |
| Work       | Replace the `@agentlet/server` dependency with `@agenetes/agentlet-gateway`, retain the local daemon supervisor, inject the authentication port, and treat the supervised local daemon as one node in the Gateway registry. The ACP driver reads bootstrap results from the live session profile and consumes early updates through the pre-attach buffer instead of DataStore/EventStore. |
| Dependency | G1 and G2.                                                                                                                                                                                                                                                                                                                                                                                 |
| Validation | The existing supervised local daemon connects, authenticates, spawns, stops, and reports status through the Gateway.                                                                                                                                                                                                                                                                       |
| Commit     | Agenetes-only commit.                                                                                                                                                                                                                                                                                                                                                                      |

### G4 — Persist explicit ACP placement in the driver spec

| Item       | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | ✅ Complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Scope      | `external/agenetes/packages/acp-driver/` plus Agenetes protocol binding definitions.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Work       | Add explicit `agentletId` placement to the ACP driver-specific create spec/binding recipe. Keep the persisted read shape backward-compatible with legacy records that omit it, resolving only those records to the host-injected supervised local daemon ID without durable migration or write-back. Because Agenetes already persists the complete WorkloadSpec in ThreadRecord, no separate generic thread-store placement field is added. Re-key live ACP caches by `(agentletId, threadId)` and remove every `getAgentlets()[0]` selection. |
| Dependency | G1 and G3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Validation | New persisted ACP WorkloadSpecs retain explicit placement across restart; a legacy spec without placement resolves to the configured supervised local daemon without being rewritten; reconnecting daemon B does not invalidate daemon A sessions; missing target daemon produces a structured placement error.                                                                                                                                                                                                                                 |
| Commit     | Agenetes-only commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### G5 — Remove ACP driver reads from agentlet stores

| Item       | Detail                                                                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | ✅ Complete as part of G3.                                                                                                                                                                                                         |
| Scope      | `external/agenetes/packages/acp-driver/src/session.ts`, `spawn-orchestrator.ts`, and related tests.                                                                                                                                |
| Work       | Preserve spawn-then-wait; resolve the composite live session connection; seed ACP client metadata from `connection.sessionProfile`; replace EventStore metadata replay with the connection's drain-once inbound pre-attach buffer. |
| Dependency | G1, G3, and G4.                                                                                                                                                                                                                    |
| Validation | Fresh sessions expose bootstrap commands, modes, models, and config options without DataStore/EventStore; same-thread native recovery remains unchanged.                                                                           |
| Commit     | Agenetes-only commit.                                                                                                                                                                                                              |

### G6 — Switch Huabu to the Gateway

| Item       | Detail                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | ✅ Complete.                                                                                                                                                                                                                                                                                                                                                                |
| Scope      | Server mount wiring, package dependencies, build scripts, daemon status projection, and current External Agent composition.                                                                                                                                                                                                                                                 |
| Work       | Register the supervised local daemon's machine name/token through the host authentication adapter, supply its `agentletId` when compiling ACP WorkloadSpecs, mount the Gateway, retain the existing single-agentlet status projection and restart endpoints, and remove runtime calls to `@agentlet/server`. Remote daemon configuration UI remains outside this migration. |
| Dependency | G3–G5.                                                                                                                                                                                                                                                                                                                                                                      |
| Validation | Existing External Agent flows work against the supervised local daemon; server restarts recover through Agenetes; no application code imports `@agentlet/server`.                                                                                                                                                                                                           |
| Commit     | Huabu-only commit; must not touch `external/agentlet/`.                                                                                                                                                                                                                                                                                                                     |

### G7 — Remove standalone agentlet-server

| Item       | Detail                                                                                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | ✅ Complete.                                                                                                                                                                                                                                                                        |
| Scope      | `external/agentlet/packages/server/`, direct bridge code in `external/agentlet/packages/local/`, standalone UI, agentlet docs/examples, and agentlet workspace metadata.                                                                                                            |
| Work       | Delete `@agentlet/server`, the `agentlet-server` binary, `agentlet --agent`, standalone REST/WS/token/UI surfaces, DataStore, EventStore, bridge-only reconnect code, and obsolete tests; replace standalone development examples with a daemon-facing Gateway integration harness. |
| Dependency | G6 is merged and green.                                                                                                                                                                                                                                                             |
| Validation | Agentlet workspace builds and tests without the server package; no source or package manifest references `@agentlet/server` or `agentlet-server`.                                                                                                                                   |
| Commit     | Agentlet-subtree-only commit.                                                                                                                                                                                                                                                       |

### G8 — Remove obsolete root build wiring

| Item       | Detail                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | ✅ Complete.                                                                                                                                              |
| Scope      | Root package scripts, server bundling configuration, development watchers, and documentation indexes.                                                     |
| Work       | Remove obsolete `@agentlet/server` build/watch/externalization entries; retain the Gateway workspace and `build:agenetes` registration introduced by G1a. |
| Dependency | G7.                                                                                                                                                       |
| Validation | Targeted agentlet, Agenetes, shared, server, and desktop builds pass from a clean checkout.                                                               |
| Commit     | Huabu-only commit.                                                                                                                                        |

### Dependency order

```text
G0
├── G1a ── G1 ──┬── G3 ── G4 ── G5 ── G6 ── G7 ── G8
└────── G2 ─────┘
```

## 11. Acceptance criteria

1. Agenetes can register and address multiple authenticated agentlet daemons by stable identity.
2. New ACP workloads are pinned to an explicit daemon and unaffected by unrelated daemon reconnects; legacy unplaced workloads remain readable through the supervised-local compatibility rule.
3. No gateway-owned durable session or event store exists.
4. Spawn environment values are not persisted by agentlet or the gateway.
5. Existing reconnect and bounded-buffer behavior continues to work without an agentlet-owned EventStore.
6. Gateway restart recovers workloads from Agenetes durable state.
7. ACP driver initialization uses bootstrap metadata from the live session connection.
8. Huabu builds and runs without `@agentlet/server` or the `agentlet-server` binary.
9. Agentlet exposes daemon mode only; direct bridge mode is no longer part of its CLI or protocol test matrix.
10. Legacy Huabu-owned agentlet store files remain untouched and are never read by the Gateway.

## 12. Future reliability backlog

The following changes are intentionally excluded from the ownership migration:

1. Replace partial message buffers with a documented end-to-end reliability contract.
2. Add sequence acknowledgement, deduplication, and replay-gap handling if later requirements justify them.
3. Make `server/spawn` wait atomically for session WebSocket readiness.
4. Consolidate spawn, disconnect, timeout, and process-exit cleanup into one daemon lifecycle primitive.
5. Consider failing session realization instead of dropping metadata when the pre-attach buffer overflows.

## 13. Related documents

- [`managed-agent-teams.md`](../proposals/managed-agent-teams.md) — depends on the shipped Gateway consolidation for multi-daemon Agent Team discovery, setup, and runtime placement.
- [`acp-eventstore-refactor-plan.md`](./acp-eventstore-refactor-plan.md) — superseded EventStore-based plan retained for historical context.
- [`layered-architecture.md`](../proposals/layered-architecture.md) — L1/L2 ownership and Agenetes package boundaries.
- [`../../external/agenetes/README.md`](../../external/agenetes/README.md) — Agenetes control-plane invariants.
- [`../../external/agentlet/spec/protocol.md`](../../external/agentlet/spec/protocol.md) — current daemon/Gateway wire contract.
