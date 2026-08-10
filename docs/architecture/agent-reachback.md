# Agent Reachback

## Overview

Agent Reachback lets an external agent attached through Agentlet access the active Huabu Space outside the normal chat prompt. Huabu exposes a canvas-scoped Remote File System (RFS) HTTP base in `HUABU_RFS_URL` and a bearer credential in `AGENTLET_TOKEN`.

The surface separates byte transfer from semantic canvas work:

```text
External agent
  ├─ skill ──────────────> bundled root guide + authenticated advanced guides
  ├─ download / upload ──> canvas file projection
  ├─ query ──────────────> canonical SpaceQuery dispatcher
  ├─ query SNAPSHOT_NODES ──> shared snapshot renderer ──> PNG artifact
  ├─ execute ────────────> agent command preparation ──> CanvasCommand engine
  └─ agent ──────────────> internal Huabu agent ──> CanvasCommand engine
```

The shipped design record is [`agent-reachback-rfs.md`](../proposals/agent-reachback-rfs.md). The planned deterministic query and mutation extension is [`direct-space-operations.md`](../proposals/direct-space-operations.md).

## Canvas-scoped HTTP surface

All endpoints are mounted under `/api/rfs/:canvasId`; `HUABU_RFS_URL` already contains that canvas-scoped base.

| Endpoint                           | Responsibility                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /skill`                       | Return the public bundled root guide, or an authenticated canvas-specific root override.    |
| `GET /skill/:skillId`              | Return an authenticated advanced guide: `layout`, `tasks`, or `agents`.                     |
| `GET /download/<path>`             | Stream a known node, artifact, or staged-upload file.                                       |
| `POST /upload/<name>`              | Stage bytes in the canvas `.upload/` directory without creating a node.                     |
| `DELETE /upload/<name>`            | Remove one exact staged upload.                                                             |
| `POST /agent`                      | Create a visible Agent Node and optionally start its first turn.                            |
| `POST /agent/:threadId/prompt`     | Submit a turn to an existing Agent conversation over SSE.                                   |
| `GET /agent/profiles`              | Return available Agent Profile IDs and aliases, including the default `huabu` Profile.      |
| `POST /task/create`                | Create a durable Task and its static Task Note.                                             |
| `POST /task/:taskId/run/create`    | Create a Run, its visible root Agent Node, and start the first turn.                        |
| `GET /capabilities`                | Report the direct-operation protocol, limits, semantics, and supported operation types.     |
| `GET /capabilities/queries/:type`  | Return one query's generated JSON Schema, constraints, result description, and examples.    |
| `GET /capabilities/commands/:type` | Return one command's generated JSON Schema, constraints, result description, and examples.  |
| `POST /query`                      | Validate and execute one bounded `SpaceQuery`, returning a query-discriminated JSON result. |
| `POST /execute`                    | Validate and execute an ordered batch of agent-allowed `CanvasCommand` variants.            |

There is no directory-listing endpoint. External agents receive exact node paths in selected-node context or ask the internal agent to discover relevant files.

## Direct query plane

`POST /query` accepts the canonical discriminated union from `packages/shared/src/types/api/space-operations.ts`: `GET_SPACE_OUTLINE`, `INSPECT_NODES`, `INSPECT_EDGES`, `SEARCH`, or `SNAPSHOT_NODES`. The RFS route validates JSON and delegates to `executeSpaceQuery()`; spatial queries reuse the existing canvas spatial services, search collects the existing cancellable event stream into a bounded JSON result, and snapshot delegates to the shared renderer. The route does not duplicate query semantics.

Capability detail schemas are generated from the same Zod registry used for request validation and built-in agent tools. Query responses remain bounded and carry metadata rather than large bodies; node content and snapshot artifact bytes are still read through `download`.

## Direct execution plane

`POST /execute` accepts `{ runId?, commands }`, rejects caller-supplied originator context and UI-only command variants, stamps server-owned agent authorship metadata, and invokes `executeOnServer()` with `{ source: 'agent' }`. The same preparation helper is used by the built-in `space_commands` tool; RFS does not call the Canvas HTTP route or duplicate executor behavior.

Node command `content` fields contain only the authored Markdown body, while downloads expose the complete sidecar with server-owned YAML frontmatter. Agent command preparation defensively unwraps a submitted leading frontmatter block only when its `id` exactly matches the `MERGE_NODE_DATA` target, preventing a downloaded sidecar from being nested into its own body without altering unrelated frontmatter-like Markdown.

An external agent may forward its injected `HUABU_THREAD_ID` in the `X-Huabu-Host-Thread-Id` header. When present, the route sets `originator.threadId` and `computeChanges`, so the batch's change-review records are persisted to that host thread's `<threadId>.changes.json` sidecar and broadcast — exactly like the built-in agent path — surfacing in the conversation's change-review card. The header only correlates the conversation; authorship stays server-owned, and a malformed or absent header simply leaves the write unattributed. See [`canvas-realtime-sync.md`](./canvas-realtime-sync.md).

Commands run in order with current partial-commit semantics. The JSON response reports the effective run ID, version transition, projected commands, every command outcome, generated node and edge IDs, affected entity IDs, new node revisions, and content conflicts. It deliberately omits Web-facing deltas, pending effects, change-review records, and conflict body content — change-review records reach the Web through the sync broadcast, not this response. A stale or unread content write is a completed business result returned with HTTP 200; the caller re-downloads the node before reconciling.

## Snapshot query

`SNAPSHOT_NODES` accepts bounded node IDs plus optional output-size and sketch-stroke subset controls through `POST /query`. Passing a frame ID recursively includes every nested image and sketch descendant, so callers do not enumerate child IDs. The query delegates to the same `snapshotNodesToArtifacts()` implementation used by the built-in `snapshot_nodes` tool, so clustering, frame expansion, content-addressing, image pass-through, and partial-sketch rendering have one implementation.

The query response returns each artifact's bare `src`, public `downloadPath`, PNG dimensions, and contributing node IDs. Snapshotting may materialize a content-addressed query-cache artifact but does not mutate canvas topology or increment the canvas version. External agents can therefore obtain the user's hand-drawn sketches without invoking the optional internal agent.

## Authentication and scoping

Every operational RFS request and every focused `GET /skill/:skillId` request requires `Authorization: Bearer <AGENTLET_TOKEN>`. The global server auth hook compares the bearer value with the active Agentlet connection token, and the canvas ID embedded in `HUABU_RFS_URL` scopes route resolution to one Space.

The only anonymous exception is `GET /skill` with no Authorization header. It returns the bundled root guide without resolving the Canvas, revealing whether it exists, or reading its `skill.md` override. An authenticated root request may resolve that override; a supplied invalid credential returns `401` rather than falling back to public documentation.

The shipped token grants access to the complete RFS surface, including direct reads and writes, and `/capabilities` reports both permissions as enabled. The canvas ID scopes route resolution but is not an independent credential or security boundary.

## File projection

Downloads expose only the public canvas projection: node Markdown sidecars, artifacts, and staged uploads. Private bookkeeping such as memory and history directories is rejected by the path resolver.

Node downloads return raw bytes plus allow-listed `X-Huabu-*` metadata headers. `X-Huabu-Node-Label` is percent-encoded, `X-Huabu-Node-Edges` contains compact JSON, and authored node content exposes its revision as an `ETag`. A matching `If-None-Match` returns `304`.

Uploads are inert payloads stored under `.upload/`. Names must be explicit and collision-free; the server returns `409` instead of overwriting an existing payload.

## Agent control plane

`POST /agent` always creates a visible Agent Node. A plain-text body is shorthand for the default `huabu` Profile plus an immediate first prompt; the full JSON form selects another available Profile, position, launch options, optional parent thread, and optional prompt. `X-Huabu-Agent-Start: false` creates an idle Agent from JSON without submitting a turn.

Parent lineage is best effort. The route resolves `parentThreadId` or `X-Huabu-Host-Thread-Id` to any Question Node in the current Space and attempts an ordinary Canvas edge after creating the Agent Node. A missing parent or rejected edge is returned as non-blocking creation metadata and never rolls back or rejects the new Agent.

`POST /agent/:threadId/prompt` addresses one existing Agent conversation directly and never creates a Node or changes its Profile. Both immediate creation and later prompts use SSE; creation streams begin with a `created` event carrying `nodeId`, `threadId`, effective `profileId`, parent-connection state, and warnings.

`GET /agent/profiles` exposes the public available Profile catalogue. It includes `huabu` as the default and projects other Profiles to stable `id` and `alias` fields without exposing commands, working directories, manifests, setup details, or registry eligibility state.

## External-agent bootstrap

Huabu injects `HUABU_RFS_URL` and `AGENTLET_TOKEN` into the external agent environment. Every external-agent Deployment persists the bootstrap as its initial preamble, including Deployments first created by mode, model, or configuration control requests; startup repair backfills older undelivered records that omitted it. The preamble owns the authentication contract and curl header setup because every external Agent needs them before loading any Skill. The complete basic guide is loaded without credentials from `GET /skill`; advanced layout, Task, recursive-Agent, and Interactive View procedures are loaded on demand from authenticated `GET /skill/layout`, `/skill/tasks`, `/skill/agents`, and `/skill/interactive-views`.

Skills explain when and how to compose workflows, but they do not duplicate the wire protocol. `GET /capabilities` and its per-operation endpoints remain the canonical, schema-derived source for current query and command fields, limits, and semantics.

The guide is direct-first: an external agent can discover, query, download, snapshot, upload, execute, and verify without creating another Agent. `POST /agent` remains an optional high-level interpretation and delegation path.

RFS errors use the normal API error body and include a runnable `/skill` recovery command so a caller can reload the current usage contract after a malformed request.

## Interactive View resources

`GET|POST /interactive-views`, `GET /interactive-views/:nodeId`, and `PUT /interactive-views/:nodeId/state` expose Interactive Views as Web Node resources rather than a separate repository. Creation accepts a staged `upload/*.html` renderer, imports it through the canonical Canvas executor, validates that the owner is a durable external Agent thread in the current Canvas namespace, validates the closed state schema, bindings, actions, and initial value, and returns the created Node identity plus a deterministic View revision. The owner identity is `canvasId + ownerThreadId`; it does not require an Agent Node or a fixed Node binding policy. State writes replace the complete value and compare that revision inside the Canvas write mutex.

The focused `GET /skill/interactive-views` guide owns the external-Agent procedure. The iframe never receives RFS credentials or routes; its runtime bridge is described in [`web-architecture.md`](./web-architecture.md).

## Environment injection and isolation

An external agent runs as an untrusted third-party CLI. It must receive its Huabu coordinates **only through explicit injection**, never through ambient environment inheritance. Two rules enforce this:

1. **Namespace strip at the transport boundary.** When the server forks the embedded agentlet daemon, the entire `HUABU_` namespace is stripped from the inherited environment (`mountAgenetes({ hostEnvPrefix: 'HUABU_', hostEnvAllowlist: [] })`). The daemon needs none of it, so its allowlist is empty; because every agent is spawned by that daemon, the agents inherit an already-clean environment. Non-namespaced OS/toolchain variables (`PATH`, `HOME`, `TMPDIR`, …) always pass through so the agent CLI still runs. The mechanism (`filterHostNamespacedEnv`) is host-agnostic — the prefix and allowlist are Huabu policy passed in by `apps/server`.

2. **Explicit reachback injection.** The only `HUABU_*` values an agent legitimately sees are re-added per-spawn by `buildReachbackEnv()`: `HUABU_RFS_URL` and `HUABU_THREAD_ID`. Anything an agent should see in future must be added to that injection point — inheritance is not a supported channel.

**Consequence for adding env vars:** a new `HUABU_*` variable is denied to agents by default. To expose one, add it to `buildReachbackEnv()` (for agents) or to `hostEnvAllowlist` (for the daemon). A host secret such as `HUABU_SECRET_KEY` must never be added to either; it is additionally scrubbed from `process.env` after `initializeSecretStore()` consumes it (see [`credential-storage.md`](./credential-storage.md)). This isolation only covers the `HUABU_` namespace — non-namespaced secrets a deployment exports into the server's own environment (e.g. provider API keys) are not filtered and should not be relied upon as agent-invisible.

## Code entry points

| File/dir                                                                                                                                       | Responsibility                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`apps/server/src/modules/remote_fs/rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts)                                       | Canvas-scoped file, capability, direct-operation, and ask-agent routes.                                   |
| [`apps/server/src/modules/remote_fs/space-capabilities.ts`](../../apps/server/src/modules/remote_fs/space-capabilities.ts)                     | Compact capability handshake and schema-derived per-operation descriptions.                               |
| [`apps/server/src/modules/remote_fs/space-execute.ts`](../../apps/server/src/modules/remote_fs/space-execute.ts)                               | Agent-friendly projection over canonical command preparation and execution.                               |
| [`apps/server/src/modules/canvas/space-query.ts`](../../apps/server/src/modules/canvas/space-query.ts)                                         | Canonical query dispatcher over spatial and search services.                                              |
| [`apps/server/src/modules/canvas/agent-command-preparation.ts`](../../apps/server/src/modules/canvas/agent-command-preparation.ts)             | Shared server-owned authorship and built-in read-set annotation.                                          |
| [`apps/server/src/modules/canvas/snapshot-nodes.ts`](../../apps/server/src/modules/canvas/snapshot-nodes.ts)                                   | Shared node-to-artifact snapshot query implementation.                                                    |
| [`apps/server/src/modules/remote_fs/node-meta.ts`](../../apps/server/src/modules/remote_fs/node-meta.ts)                                       | Safe path projection and node metadata headers.                                                           |
| [`apps/server/src/modules/remote_fs/skill.ts`](../../apps/server/src/modules/remote_fs/skill.ts)                                               | Resolve the public bundled root, authenticated canvas override, and advanced guides.                      |
| [`apps/server/src/prompt/external-agent/access-huabu.md`](../../apps/server/src/prompt/external-agent/access-huabu.md)                         | Agent-facing RFS procedure served by `GET /skill`.                                                        |
| [`apps/server/src/prompt/external-agent/layout.md`](../../apps/server/src/prompt/external-agent/layout.md)                                     | Advanced RFS adapter over the shared Space layout recipes.                                                |
| [`apps/server/src/prompt/external-agent/tasks.md`](../../apps/server/src/prompt/external-agent/tasks.md)                                       | Durable Task and Run workflow served by `GET /skill/tasks`.                                               |
| [`apps/server/src/prompt/external-agent/agents.md`](../../apps/server/src/prompt/external-agent/agents.md)                                     | Delegated and recursive Agent workflow served by `GET /skill/agents`.                                     |
| [`apps/server/src/prompt/external-agent/interactive-views.md`](../../apps/server/src/prompt/external-agent/interactive-views.md)               | Interactive View creation and bridge workflow served by `GET /skill/interactive-views`.                   |
| [`apps/server/src/modules/interactive-view/`](../../apps/server/src/modules/interactive-view/)                                                 | View resource validation, persistence, binding snapshots, and Agent action dispatch.                      |
| [`apps/server/src/prompt/external-agent/system-preamble.ts`](../../apps/server/src/prompt/external-agent/system-preamble.ts)                   | Render the canonical external-agent bootstrap preamble.                                                   |
| [`apps/server/src/modules/agent/acp/reachback-env.ts`](../../apps/server/src/modules/agent/acp/reachback-env.ts)                               | Inject the canvas-scoped RFS environment into external sessions.                                          |
| [`apps/server/src/modules/storage/migrate-agenetes-threads.ts`](../../apps/server/src/modules/storage/migrate-agenetes-threads.ts)             | Repair persisted undelivered external Deployments that omitted the bootstrap preamble.                    |
| [`external/agenetes/packages/agentlet-host/src/daemon-supervisor.ts`](../../external/agenetes/packages/agentlet-host/src/daemon-supervisor.ts) | Fork/supervise the daemon; `filterHostNamespacedEnv` strips the host namespace at the transport boundary. |
| [`packages/shared/src/types/api/rfs.ts`](../../packages/shared/src/types/api/rfs.ts)                                                           | Shared file-plane RFS wire schemas, headers, and constants.                                               |
| [`packages/shared/src/types/api/space-operations.ts`](../../packages/shared/src/types/api/space-operations.ts)                                 | Canonical direct-operation request, response, capability, and limit contracts.                            |
| [`external/agentlet/spec/agent-reachback.md`](../../external/agentlet/spec/agent-reachback.md)                                                 | Host-agnostic Agentlet reachback transport contract.                                                      |
