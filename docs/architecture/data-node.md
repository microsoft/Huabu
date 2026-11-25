# Data Node

> Last updated: 2026-04-20

First-class Canvas node (`type: 'data'`) whose authored body is canonical UTF-8 JSON, optionally constrained by an inline structural JSON Schema subset (`dataSchema`), with protected human editing and capability-bound HTML form read/write bindings.

---

## 1. Data model & invariants

```ts
interface DataNodeData extends BaseNodeData {
  type: 'data';
  content: string; // canonical 2-space pretty-printed JSON (defaults to "{}")
  dataSchema?: DataNodeSchemaV1; // optional closed JSON Schema subset
}
```

Every write path — `CREATE_NODES`, `MERGE_NODE_DATA`, `RESTORE_NODES`, standalone `PUT /api/canvas/:id/nodes/:nodeId/content`, and Interactive View `PUT /api/interactive-views/:canvasId/:nodeId/bindings/:bindingId` — enforces the same validation rules from [`packages/shared/src/utils/data-node-validation.ts`](../../packages/shared/src/utils/data-node-validation.ts):

- **Valid bounded JSON**: `content` must parse as valid JSON within the shared Interactive View depth, array-length, object-key, string-length, and 64 KiB byte bounds, and is persisted in canonical 2-space pretty-printed form (`JSON.stringify(parsed, null, 2)`). When omitted at creation, `content` defaults to `"{}"` (or `"null"` when `dataSchema.type === 'null'`).
- **Optional `dataSchema`**: reuses `InteractiveViewStateSchemaV1` (`DataNodeSchemaV1`: `object`, `array`, `string`, `number`, `boolean`, `null`, `enum`, `required`, `additionalProperties: false`, bounds). When present, every write validates the parsed JSON value against `dataSchema`; clearing `dataSchema` passes `null` in content/command patches.
- **No-secrets rule**: Data Nodes store non-secret structured configuration and workflow state, never credentials. Both `dataSchema` property names and JSON object keys at any nesting depth reject prohibited secret-like field names (`password`, `passwd`, `secret`, `token`, `apikey`, `privatekey`, `credential`, `credentials`, normalized case- and separator-insensitively). Secrets belong exclusively in [credential-storage.md](./credential-storage.md) or [service-packages.md](./service-packages.md).

## 2. Storage, revisions, and instruction Frames

`content` and `dataSchema` are authored `SpaceNodes` sidecar fields (`NODE_CONTENT_KEYS`), stripped from structural `space.json` topology on Disk and stored in the node sidecar YAML frontmatter (`dataSchema`) plus raw JSON body (`content`), or in the canonical `nodes` record on SQLite and PostgreSQL. No SQL schema migration is required.

`nodeRevisionOf` hashes `(type: 'data', content, dataSchema)` so `rev` changes whenever either the JSON value or its schema changes, while label/geometry/property edits leave `rev` untouched. Stale body or schema writes fail with `409 NODE_CONTENT_CONFLICT` rather than overwriting concurrent edits.

Space instruction Frames ([agent-context.md](./agent-context.md#33-space-instruction-frames)) treat direct-child Data Nodes alongside Notes:

- **`prompt` / `prompt: <name>` Frames** inject only the JSON `content` inside `<data id="..." label="..." file="..." rev="...">\n...\n</data>`, deliberately omitting `dataSchema` to keep Agent prompt tokens lean.
- **`skill` / `skill: <name>` Frames** emit a compact `<data id="..." label="..." file="..." rev="..." />` reference; Agents inspect or download the node via `huabu-rfs download <nodeId>` (or built-in `read`) when they need the full YAML frontmatter including `dataSchema`.

## 3. Protected Canvas & Preview UX

Data Nodes are created by Agents (`CREATE_NODES` with `nodeType: 'data'`) or clipboard paste/import; manual Canvas toolbar creation is deferred ([manual-data-node-creation.md](../backlog/manual-data-node-creation.md)).

- **Canvas card (`DataNode`)**: strictly read-only summary card displaying the `Braces` icon, label, optional `Schema` badge, and a truncated monospace JSON preview without inline editing controls. Double-clicking or clicking Maximize opens the expanded preview.
- **Protected Preview (`DataPreview`)**: opens in **Read-Only** mode by default so viewing or selecting a Data Node never mutates state or risks accidental edits. Users with Space write permission click **Edit** to enter a local draft buffer (`TextArea` monospace) seeded with the authoritative server `rev` and `dataSchema`.
- **Client-side validation & dirty guards**: local JSON syntax, `dataSchema`, and prohibited secret-key validation run live against the draft and disable **Save** until valid. While the draft is dirty, `beforeunload` warns before closing a browser tab and `Escape` / **Cancel** opens a confirmation `Modal` instead of silently discarding edits.
- **Explicit CAS Save & conflict preservation**: clicking **Save** sends a single `PUT /api/canvas/:id/nodes/:nodeId/content` with `expectRev` (bypassing keystroke-debounced auto-save) and calls `adoptRemoteNodeContent` to advance store state cleanly. On `409 NODE_CONTENT_CONFLICT`, the user's draft stays intact and a conflict banner offers **Reload latest** or **Overwrite with my draft** against the newly fetched revision.

## 4. HTML Form bindings (`Interactive View`)

Local-HTML Web Nodes (`data.interactiveView`) can act as pure schema-aware forms bound to one or more Data Nodes without requiring an Agent conversation or View-local `state`:

```text
Agent (CREATE_NODES data + upload form.html + interactive-view create)
  │
  ▼
Web Node (data.interactiveView) ── MessagePort ──> useInteractiveViewBridge
  ├─ binding: { bindingId, source: { kind: "data-node", nodeId } }
  └─ action:  { actionId,  kind: "data.replace", bindingId }
        │
        ▼
PUT /api/interactive-views/:canvasId/:nodeId/bindings/:bindingId (CAS on rev)
```

- **Optional thread & local state**: `ownerThreadId` is required only when `actions` grants `agent.submit`. `state` is optional and defaults to `{ schema: { type: 'null' }, value: null }`.
- **Node-level read binding (`source: { kind: 'data-node', nodeId }`)**: `GET /api/interactive-views/:canvasId/:nodeId/runtime` resolves each bound Data Node in the same Space and injects `{ revision, value: { status: 'ready', nodeId, label, value, schema }, references: { nodeIds: [nodeId], threadIds: [] } }`. Deleted or non-`data` targets return `{ status: 'missing', nodeId, message }` rather than crashing bootstrap.
- **Whole-node CAS write (`kind: 'data.replace'`)**: `PUT /api/interactive-views/:canvasId/:nodeId/bindings/:bindingId` verifies that `actions` grants `data.replace` for `bindingId`, validates `{ revision, value }` against prohibited secret keys and the target Data Node's stored `dataSchema`, writes the canonical JSON under the Canvas mutex with `expectRev: revision`, broadcasts `CanvasSync` `invalidate`, and returns the updated snapshot. Stale revisions return `409 data_node_conflict` with `{ currentRevision, currentValue }` in `outcome.details` so the HTML form can reconcile without losing user input.
- **Live sync & topology remapping**: `useInteractiveViewBridge` subscribes to `CanvasSync` and refreshes runtime data whenever a bound `data-node` or `canvas.nodes` target is invalidated or updated externally. Clipboard paste, cross-Space move, and single-Space bundle import remap `data-node.nodeId` when theView and Data Node travel together and deduplicate `viewKey` collisions on paste.

## 5. Code entry points

| File/dir                                                                                                                                             | Responsibility                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`packages/shared/src/utils/data-node-validation.ts`](../../packages/shared/src/utils/data-node-validation.ts)                                       | Zod-free JSON bounds, `DataNodeSchemaV1` validator, secret-key guard, and canonical formatter.           |
| [`packages/shared/src/types/api/interactive-view.ts`](../../packages/shared/src/types/api/interactive-view.ts)                                       | Wire contracts for `DataNodeSchemaV1`, `data-node` bindings, `data.replace`, and optional `state`/owner. |
| [`apps/server/src/modules/canvas/canvas-executor.ts`](../../apps/server/src/modules/canvas/canvas-executor.ts)                                       | Server command validation and `dataSchema` sidecar persistence for `data` nodes.                         |
| [`apps/server/src/modules/agent/space-instruction-frames.ts`](../../apps/server/src/modules/agent/space-instruction-frames.ts)                       | `<data>` Prompt inline injection (JSON body only) and Skill reference rendering.                         |
| [`apps/server/src/modules/interactive-view/interactive-view.service.ts`](../../apps/server/src/modules/interactive-view/interactive-view.service.ts) | `data-node` runtime projection and `replaceDataNode` CAS persistence.                                    |
| [`packages/client-runtime/src/rfs-cli.ts`](../../packages/client-runtime/src/rfs-cli.ts)                                                             | Thin `huabu-rfs interactive-view` (`list`, `get`, `create`, `replace-state`) CLI commands.               |
| [`apps/web/src/components/Nodes/data/DataNode.tsx`](../../apps/web/src/components/Nodes/data/DataNode.tsx)                                           | Read-only Canvas card with `Schema` badge and truncated JSON summary.                                    |
| [`apps/web/src/components/Nodes/data/DataPreview.tsx`](../../apps/web/src/components/Nodes/data/DataPreview.tsx)                                     | Protected Read-Only -> Edit/Save/Cancel preview, schema/secret validation, and `409` conflict recovery.  |
| [`apps/web/src/components/Nodes/web/useInteractiveViewBridge.ts`](../../apps/web/src/components/Nodes/web/useInteractiveViewBridge.ts)               | `data.replace` intent execution, `adoptRemoteNodeContent`, and live `CanvasSync` refresh.                |
