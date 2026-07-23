# Agent Reachback

## Overview

Agent Reachback lets an external agent attached through Agentlet access the active Huabu Space outside the normal chat prompt. Huabu exposes a canvas-scoped Remote File System (RFS) HTTP base in `HUABU_RFS_URL` and a bearer credential in `AGENTLET_TOKEN`.

The surface separates byte transfer from semantic canvas work:

```text
External agent
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
| `GET /skill`                       | Return the bundled access guide or a canvas-specific override.                              |
| `GET /download/<path>`             | Stream a known node, artifact, or staged-upload file.                                       |
| `POST /upload/<name>`              | Stage bytes in the canvas `.upload/` directory without creating a node.                     |
| `DELETE /upload/<name>`            | Remove one exact staged upload.                                                             |
| `POST /agent`                      | Run or continue a canvas-internal agent turn over SSE.                                      |
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

Commands run in order with current partial-commit semantics. The JSON response reports the effective run ID, version transition, projected commands, every command outcome, generated node and edge IDs, affected entity IDs, new node revisions, and content conflicts. It deliberately omits Web-facing deltas, pending effects, change-review records, and conflict body content. A stale or unread content write is a completed business result returned with HTTP 200; the caller re-downloads the node before reconciling.

## Snapshot query

`SNAPSHOT_NODES` accepts bounded node IDs plus optional output-size and sketch-stroke subset controls through `POST /query`. Passing a frame ID recursively includes every nested image and sketch descendant, so callers do not enumerate child IDs. The query delegates to the same `snapshotNodesToArtifacts()` implementation used by the built-in `snapshot_nodes` tool, so clustering, frame expansion, content-addressing, image pass-through, and partial-sketch rendering have one implementation.

The query response returns each artifact's bare `src`, public `downloadPath`, PNG dimensions, and contributing node IDs. Snapshotting may materialize a content-addressed query-cache artifact but does not mutate canvas topology or increment the canvas version. External agents can therefore obtain the user's hand-drawn sketches without invoking the optional internal agent.

## Authentication and scoping

Every RFS request requires `Authorization: Bearer <AGENTLET_TOKEN>`. The global server auth hook compares the bearer value with the active Agentlet connection token, and the canvas ID embedded in `HUABU_RFS_URL` scopes route resolution to one Space.

The shipped token grants access to the complete RFS surface, including direct reads and writes, and `/capabilities` reports both permissions as enabled. The canvas ID scopes route resolution but is not an independent credential or security boundary.

## File projection

Downloads expose only the public canvas projection: node Markdown sidecars, artifacts, and staged uploads. Private bookkeeping such as memory and history directories is rejected by the path resolver.

Node downloads return raw bytes plus allow-listed `X-Huabu-*` metadata headers. `X-Huabu-Node-Label` is percent-encoded, `X-Huabu-Node-Edges` contains compact JSON, and authored node content exposes its revision as an `ETag`. A matching `If-None-Match` returns `304`.

Uploads are inert payloads stored under `.upload/`. Names must be explicit and collision-free; the server returns `409` instead of overwriting an existing payload.

## Internal-agent control plane

`POST /agent` accepts a plain-text prompt or the legacy validated JSON request and always responds as `text/event-stream`. Comment heartbeats keep the connection alive, `: threadId` identifies the live conversation, and final text is carried in `data:` frames.

The internal agent owns current graph discovery and mutation. It resolves spatial intent, consumes staged uploads, and executes mutations through the shared server-side `CanvasCommand` engine. The request can continue a live turn through `X-Huabu-Thread-Id`; handles are not durable across Huabu restarts.

## External-agent bootstrap

Huabu injects `HUABU_RFS_URL` and `AGENTLET_TOKEN` into the external agent environment. The external system prompt contains only the bootstrap instruction; the detailed procedural guide is loaded on demand from `GET /skill`.

The guide is direct-first: an external agent can discover, query, download, snapshot, upload, execute, and verify without invoking `POST /agent` or configuring an internal model provider. `POST /agent` remains an optional high-level interpretation path.

RFS errors use the normal API error body and include a runnable `/skill` recovery command so a caller can reload the current usage contract after a malformed request.

## Code entry points

| File/dir                                                                                                                           | Responsibility                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`apps/server/src/modules/remote_fs/rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts)                           | Canvas-scoped file, capability, direct-operation, and ask-agent routes.        |
| [`apps/server/src/modules/remote_fs/space-capabilities.ts`](../../apps/server/src/modules/remote_fs/space-capabilities.ts)         | Compact capability handshake and schema-derived per-operation descriptions.    |
| [`apps/server/src/modules/remote_fs/space-execute.ts`](../../apps/server/src/modules/remote_fs/space-execute.ts)                   | Agent-friendly projection over canonical command preparation and execution.    |
| [`apps/server/src/modules/canvas/space-query.ts`](../../apps/server/src/modules/canvas/space-query.ts)                             | Canonical query dispatcher over spatial and search services.                   |
| [`apps/server/src/modules/canvas/agent-command-preparation.ts`](../../apps/server/src/modules/canvas/agent-command-preparation.ts) | Shared server-owned authorship and built-in read-set annotation.               |
| [`apps/server/src/modules/canvas/snapshot-nodes.ts`](../../apps/server/src/modules/canvas/snapshot-nodes.ts)                       | Shared node-to-artifact snapshot query implementation.                         |
| [`apps/server/src/modules/remote_fs/node-meta.ts`](../../apps/server/src/modules/remote_fs/node-meta.ts)                           | Safe path projection and node metadata headers.                                |
| [`apps/server/src/modules/remote_fs/skill.ts`](../../apps/server/src/modules/remote_fs/skill.ts)                                   | Resolve the bundled or canvas-specific access guide.                           |
| [`apps/server/src/prompt/external-agent/access-huabu.md`](../../apps/server/src/prompt/external-agent/access-huabu.md)             | Agent-facing RFS procedure served by `GET /skill`.                             |
| [`apps/server/src/modules/agent/acp/reachback-env.ts`](../../apps/server/src/modules/agent/acp/reachback-env.ts)                   | Inject the canvas-scoped RFS environment into external sessions.               |
| [`packages/shared/src/types/api/rfs.ts`](../../packages/shared/src/types/api/rfs.ts)                                               | Shared file-plane RFS wire schemas, headers, and constants.                    |
| [`packages/shared/src/types/api/space-operations.ts`](../../packages/shared/src/types/api/space-operations.ts)                     | Canonical direct-operation request, response, capability, and limit contracts. |
| [`external/agentlet/spec/agent-reachback.md`](../../external/agentlet/spec/agent-reachback.md)                                     | Host-agnostic Agentlet reachback transport contract.                           |
