# Agent Reachback

## Overview

Agent Reachback lets an external agent attached through Agentlet access the active Huabu Space outside the normal chat prompt. Huabu exposes a canvas-scoped Remote File System (RFS) HTTP base in `HUABU_RFS_URL` and a bearer credential in `AGENTLET_TOKEN`.

The shipped surface separates byte transfer from semantic canvas work:

```text
External agent
  ├─ download / upload ──> canvas file projection
  └─ agent ──────────────> internal Huabu agent ──> CanvasCommand engine
```

The shipped design record is [`agent-reachback-rfs.md`](../proposals/agent-reachback-rfs.md). The planned deterministic query and mutation extension is [`direct-space-operations.md`](../proposals/direct-space-operations.md).

## Canvas-scoped HTTP surface

All endpoints are mounted under `/api/rfs/:canvasId`; `HUABU_RFS_URL` already contains that canvas-scoped base.

| Endpoint | Responsibility |
|---|---|
| `GET /skill` | Return the bundled access guide or a canvas-specific override. |
| `GET /download/<path>` | Stream a known node, artifact, or staged-upload file. |
| `POST /upload/<name>` | Stage bytes in the canvas `.upload/` directory without creating a node. |
| `DELETE /upload/<name>` | Remove one exact staged upload. |
| `POST /agent` | Run or continue a canvas-internal agent turn over SSE. |

There is no directory-listing endpoint. External agents receive exact node paths in selected-node context or ask the internal agent to discover relevant files.

## Authentication and scoping

Every RFS request requires `Authorization: Bearer <AGENTLET_TOKEN>`. The global server auth hook compares the bearer value with the active Agentlet connection token, and the canvas ID embedded in `HUABU_RFS_URL` scopes route resolution to one Space.

The shipped token grants access to the complete RFS surface. Separate effective read and write capabilities are part of the direct-operation proposal and are not current behavior.

## File projection

Downloads expose only the public canvas projection: node Markdown sidecars, artifacts, and staged uploads. Private bookkeeping such as memory and history directories is rejected by the path resolver.

Node downloads return raw bytes plus allow-listed `X-Huabu-*` metadata headers. `X-Huabu-Node-Label` is percent-encoded, `X-Huabu-Node-Edges` contains compact JSON, and authored node content exposes its revision as an `ETag`. A matching `If-None-Match` returns `304`.

Uploads are inert payloads stored under `.upload/`. Names must be explicit and collision-free; the server returns `409` instead of overwriting an existing payload.

## Internal-agent control plane

`POST /agent` accepts a plain-text prompt or the legacy validated JSON request and always responds as `text/event-stream`. Comment heartbeats keep the connection alive, `: threadId` identifies the live conversation, and final text is carried in `data:` frames.

The internal agent owns current graph discovery and mutation. It resolves spatial intent, consumes staged uploads, and executes mutations through the shared server-side `CanvasCommand` engine. The request can continue a live turn through `X-Huabu-Thread-Id`; handles are not durable across Huabu restarts.

## External-agent bootstrap

Huabu injects `HUABU_RFS_URL` and `AGENTLET_TOKEN` into the external agent environment. The external system prompt contains only the bootstrap instruction; the detailed procedural guide is loaded on demand from `GET /skill`.

RFS errors use the normal API error body and include a runnable `/skill` recovery command so a caller can reload the current usage contract after a malformed request.

## Code entry points

| File/dir | Responsibility |
|---|---|
| [`apps/server/src/modules/remote_fs/rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts) | Canvas-scoped download, upload, skill, and ask-agent routes. |
| [`apps/server/src/modules/remote_fs/node-meta.ts`](../../apps/server/src/modules/remote_fs/node-meta.ts) | Safe path projection and node metadata headers. |
| [`apps/server/src/modules/remote_fs/skill.ts`](../../apps/server/src/modules/remote_fs/skill.ts) | Resolve the bundled or canvas-specific access guide. |
| [`apps/server/src/prompt/external-agent/access-huabu.md`](../../apps/server/src/prompt/external-agent/access-huabu.md) | Agent-facing RFS procedure served by `GET /skill`. |
| [`apps/server/src/modules/agent/acp/reachback-env.ts`](../../apps/server/src/modules/agent/acp/reachback-env.ts) | Inject the canvas-scoped RFS environment into external sessions. |
| [`packages/shared/src/types/api/rfs.ts`](../../packages/shared/src/types/api/rfs.ts) | Shared RFS wire schemas, headers, and constants. |
| [`external/agentlet/spec/agent-reachback.md`](../../external/agentlet/spec/agent-reachback.md) | Host-agnostic Agentlet reachback transport contract. |
