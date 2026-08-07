# Direct Space Operations for External Agents

Status: In-Progress

Last updated: 2026-07-22

Tracking issue: [#348](https://github.com/hai-team/Huabu/issues/348)

## Context

The shipped [Agent Reachback](../architecture/agent-reachback.md) surface provides deterministic file transfer, but graph discovery and mutations still require `POST /agent`. This proposal extends that RFS base so an external agent can operate the Space without configuring an internal-agent provider.

The existing `download`, `upload`, `agent`, and `skill` endpoints remain available. Direct operations are an additional deterministic control plane, not a replacement RFS implementation.

## Decision

Add a canvas-scoped native HTTP facade over shared read and mutation contracts:

```text
GET  $HUABU_RFS_URL/capabilities
GET  $HUABU_RFS_URL/capabilities/queries/:type
GET  $HUABU_RFS_URL/capabilities/commands/:type
POST $HUABU_RFS_URL/query
POST $HUABU_RFS_URL/execute
```

`SpaceQuery` is the canonical read DSL. The agent-allowed subset of `CanvasCommand` is the canonical mutation DSL. Route handlers validate and dispatch these contracts but do not implement canvas query or mutation rules.

Native HTTP plus a procedural `huabu-space-operations` skill is the first complete #348 channel. CLI and MCP integrations are optional later adapters over the same contracts.

## Shared contracts

Runtime-validatable request and response schemas belong in `packages/shared/src/types/api/` according to [API Design](../architecture/api-design.md). The server route, internal agent tools, capability descriptions, tests, and future adapters must consume the same canonical contracts.

The MVP `SpaceQuery` union contains:

- `GET_SPACE_OUTLINE`
- `INSPECT_NODES`
- `INSPECT_EDGES`
- `SEARCH`

Query dispatch reuses the existing canvas spatial and search services. Normal direct queries return bounded JSON. Large node bodies and artifacts remain file references retrieved through `download`; the existing cancellable NDJSON search endpoint may remain as a compatibility streaming adapter.

The execution request accepts only agent-allowed `CanvasCommand` variants. UI-only selection, locking, and node-type interaction commands remain unavailable.

## Capability discovery

`GET /capabilities` is a compact handshake containing the protocol version, effective permissions, execution semantics, limits, supported query types, supported command types, and links to detailed operation descriptions.

Per-operation capability endpoints expose one operation's runtime schema, concise constraints, result shape, and curated examples. They must derive from or live beside the shared runtime contracts so validation and documentation do not drift.

## Execution behavior

`POST /execute` reuses the canonical server executor and current persistence path. It returns every per-command outcome, generated IDs, versions, revisions, conflicts, and actionable structured errors available from that path.

Issue #348 deliberately preserves current execution semantics:

- Commands run in order and can observe earlier accepted commands.
- Rejected commands do not roll back accepted commands.
- The accepted subset commits once when at least one command changes state.
- `runId` is tracing metadata, not an idempotency key.
- Clients must not automatically retry after an ambiguous transport failure; they re-query and reconcile first.

Transactional batches, durable multi-file atomicity, request idempotency, exactly-once execution, and a SQLite storage migration are outside this issue.

## Authorization constraint

The first version reuses the current RFS bearer token, which grants the complete RFS surface. The direct facade reports effective read and write permissions separately as enabled; the canvas ID routes operations to one Space but is not represented as an independent security boundary. A narrower capability credential is outside issue #348 and authorization logic does not enter query or command adapters.

## Procedural skill

The skill teaches external agents to resolve selected-node references, load capabilities progressively, keep queries bounded, download large content to files, read before content writes, confirm destructive or broad mutations, inspect every command outcome, and reconcile ambiguous execution results.

The skill contains workflow and bounded examples, not duplicated runtime schemas or canvas business rules. Direct mode must not call `POST /agent`.

## Delivery sequence

1. Publish shared `SpaceQuery`, execution, capability, and response schemas.
2. Reuse the existing spatial/search services behind a query dispatcher.
3. Add compact and per-operation capability endpoints.
4. Add direct query and execute routes under the RFS base.
5. Publish the procedural direct-operation skill.
6. Validate the complete workflow with no internal-agent provider configured.

## Acceptance criteria

- An external agent inspects an anchor, reads referenced content, creates or updates a Markdown node, places and links it, and verifies the result without an internal-agent provider.
- Direct mode sends no request to `POST /agent`.
- Query and command input is validated by shared runtime schemas.
- Capability discovery exposes effective permissions, limits, variants, and current partial-commit/non-idempotent semantics.
- Every command outcome and every server-assigned ID needed for follow-up work is visible.
- Content updates use revision preconditions and expose stale-write conflicts.
- A direct-mode integration test covers the end-to-end workflow.

## Code entry points

| File/dir                                                                                                         | Responsibility                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`packages/shared/src/types/canvas/command.ts`](../../packages/shared/src/types/canvas/command.ts)               | Current shared TypeScript `CanvasCommand` and agent-allowed command union.     |
| [`packages/shared/src/types/api/space-operations.ts`](../../packages/shared/src/types/api/space-operations.ts)   | Canonical direct-operation request, response, capability, and limit contracts. |
| [`apps/server/src/modules/agent/tools/definitions.ts`](../../apps/server/src/modules/agent/tools/definitions.ts) | Internal-agent tools adapted from the canonical shared contracts.              |
| [`apps/server/src/modules/canvas/canvas-spatial.ts`](../../apps/server/src/modules/canvas/canvas-spatial.ts)     | Existing outline and inspect implementations.                                  |
| [`apps/server/src/modules/canvas/canvas-search.ts`](../../apps/server/src/modules/canvas/canvas-search.ts)       | Existing bounded, cancellable search implementation.                           |
| [`apps/server/src/modules/canvas/canvas-executor.ts`](../../apps/server/src/modules/canvas/canvas-executor.ts)   | Canonical server-side mutation execution and persistence path.                 |
| [`apps/server/src/modules/remote_fs/rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts)         | Existing RFS facade to extend with direct operations.                          |
