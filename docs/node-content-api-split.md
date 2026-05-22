# Node Content API Split

Standalone plan for separating per-node markdown writes from the canvas
structure PUT. Pre-requisite groundwork for
[`headless-executor-plan.md`](./headless-executor-plan.md) M4 (Yjs for
note content), but useful on its own — ships before M1 if desired.

## Goals

1. Editor edits to a single node never touch `canvas.json` and never
   collide with the canvas `version` optimistic-concurrency check.
2. Structure mutations (drag, edges, viewport, frame parenthood) stop
   re-writing every node's `.md` sidecar on every autosave tick.
3. `nodes/<safe(label)>.md` is the **only** path on which node content,
   summary, keywords, provenance, and `.md` filename rename are
   persisted. `canvas.json` becomes purely structural.
4. Map 1:1 onto M4's per-node Y.Doc model so M4 only has to swap the
   transport, not redesign the persistence path.

## Non-Goals

- No engine extraction (that's M1).
- No server-side executor, no delta log, no SSE (that's M2/M3).
- No WebSocket, no Yjs, no Milkdown collab plugin (that's M4).
- No change to `DELETE /:canvasId/nodes/:nodeId` or `POST
/:canvasId/nodes/:nodeId/preprocess` — both already operate per-node.
- No change to undo/redo, chat-panel revert, or agent command pipeline.

## Context

Today the storage layer is already split — `canvas.json` carries
structure; `nodes/<safe(label)>.md` carries content — but the **API is
not**. `PUT /api/canvas/:canvasId` accepts the whole canvas state with
`content` inlined on every node, and
[`persistAndStripNodes`](../apps/server/src/modules/canvas/canvas.route.ts)
re-writes every MD-backed node's `.md` file on every autosave (1s
debounce, ~50 KB upstream typing a single note in a 50-node canvas).

Consequences:

| Symptom                                                            | Cause                                              |
| ------------------------------------------------------------------ | -------------------------------------------------- |
| Drag a node → all node `.md` files re-written                      | `persistAndStripNodes` loops every node            |
| Editor input contends with viewport changes for the same `version` | One PUT, one version counter                       |
| `CANVAS_VERSION_CONFLICT` toast can interrupt a typing session     | Content piggybacks on structure versioning         |
| Label rename validation must batch-pre-check every node            | Single endpoint owns both rename + structure write |

## Design

### Wire Contract (additions to `packages/shared/src/types/api/canvas.ts`)

```ts
// PUT /api/canvas/:canvasId/nodes/:nodeId/content
export const putNodeContentBodySchema = z.object({
  nodeType: z.string().min(1),
  content: z.string().optional(), // text-bearing nodes only
  label: z.string().nullable().optional(),
  labelSource: z.enum(['user', 'auto', 'agent']).optional(),
  src: z.string().optional(),
  summary: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  provenance: z.unknown().optional(), // pass-through frontmatter blob
});
export type PutNodeContentRequest = z.infer<typeof putNodeContentBodySchema>;

export interface PutNodeContentResponse {
  nodeId: string;
  label: string | null; // server-resolved (may carry " (2)" suffix)
  contentMissing?: boolean;
  artifactMissing?: boolean;
}

// GET /api/canvas/:canvasId/nodes/:nodeId/content
export interface GetNodeContentResponse {
  nodeId: string;
  type: string;
  label: string | null;
  src?: string;
  content: string;
  summary?: string;
  keywords?: string[];
  contentMissing?: boolean;
  artifactMissing?: boolean;
}
```

Reuse the existing `CanvasConflictResponse` with `code:
'NODE_LABEL_CONFLICT'` for 409 responses. No new error codes.

### Server (apps/server/src/modules/canvas/canvas.route.ts)

**New endpoints**

```
PUT  /api/canvas/:canvasId/nodes/:nodeId/content
GET  /api/canvas/:canvasId/nodes/:nodeId/content
```

PUT handler:

1. zod-validate body via `putNodeContentBodySchema.safeParse`.
2. `store.read()` → 404 if canvas missing.
3. Read existing `store.readNode(nodeId)` as fallback for unspecified
   fields (label/src) and for the `wouldClobber` empty-content guard
   already used by `persistAndStripNodes`.
4. Compose `NodeContent` from incoming + fallback fields.
5. `strictRename = labelSource === 'user'`.
6. `store.writeNode(nodeId, nodeContent, { strictRename })`.
7. On `{ ok: false, reason: 'conflict' }` → 409 with
   `{ code: 'NODE_LABEL_CONFLICT', nodeId, conflictWith }`.
8. On success return
   `{ nodeId, label: result.label, contentMissing?, artifactMissing? }`.
   `result.label` carries the agent-auto-dedupe suffix when applicable.

GET handler: extract the per-node body of the existing
`hydrateNodeContent` into a helper
`hydrateOneNode(store, nodeId, nodeType)`; both `GET /:canvasId` and
the new `GET /content` use it.

**`persistAndStripNodes` → `stripNodesForCanvas` (no more disk writes)**

The structure PUT no longer owns any `.md` lifecycle:

- **Delete**: the pre-pass (`checkNodeRename` + `reservedSlots`).
- **Delete**: the per-node `store.writeNode(...)` write loop.
- **Delete**: `RenamedNode[]` return path — content PUT writes the
  `.md` (and resolves any label dedupe) directly.
- **Strip**: `content` / `summary` / `keywords` / `label` /
  `labelSource` / `src` / `provenance` from `node.data` — all of
  these live in `.md` frontmatter, none belong in `canvas.json`.
- **Keep**: everything else (`id`, `type`, geometry, `parentId`,
  edges, viewport, frame children, custom data).

The function becomes a pure data reshape — no FS, no rename
detection, no label awareness.

**`canvas.json` no longer carries `label` at all**

This is the clean version of the rule "`.md` is the source of truth
for content": label is part of the node's content (it's the `id:` /
`label:` line in frontmatter and the filename of the `.md`), so it
does not appear in `canvas.json` either. Every node type already has
an `.md` sidecar — `note / text / web / pdf` carry body, `image /
video / frame` carry frontmatter-only — so there is no node type
that needs `canvas.json` as a label fallback.

Consequences:

- **No drift is representable.** There is exactly one persisted
  copy of label (`.md` frontmatter); reading it twice cannot disagree.
- **Hydrate becomes uniform** — see next section.
- **The structure PUT body shrinks** further (no per-node label
  string for every save).

**Hydrate rule simplifies**

Today `hydrateNodeContent` has a branch: `.md` label wins when
`labelSource === 'auto'`, otherwise `canvas.json` label wins. After
the split, hydrate uses one rule:

```ts
// pseudo-code inside hydrateOneNode
if (nodeContent) {
  data.label = nodeContent.label;
  data.labelSource = nodeContent.labelSource ?? 'auto';
} else {
  data.label = null;
  data.contentMissing = true;
}
```

The `contentMissing` flag is already produced today; UI already
renders a non-blocking placeholder for it. New-node UX (structure PUT
landed, content PUT in flight) reuses this exact path.

**`RenamedNode` is deleted, `PutCanvasResponse.renamedNodes` removed**

Agent labels are auto-deduped inside the content PUT; that endpoint
returns the resolved label directly to the per-node flush in the web
store. Structure PUT no longer participates in rename and has
nothing to report. PR-B deletes the `RenamedNode` type from
`packages/shared/src/types/api/canvas.ts` and removes
`PutCanvasResponse.renamedNodes` outright — no deprecation window.
The "stale browser tab open across deploy" failure mode is
strictly the same as today's stale-PUT scenario and is acceptable
for a single-user-per-machine product.

### Web Client

**API helpers (apps/web/src/api/canvas.ts)**

```ts
export async function putNodeContent(
  canvasId: string,
  nodeId: string,
  body: PutNodeContentRequest,
  options?: { keepalive?: boolean },
): Promise<PutNodeContentResponse>;

export async function getNodeContent(
  canvasId: string,
  nodeId: string,
): Promise<GetNodeContentResponse | null>;
```

`putNodeContent` mirrors `putCanvas`'s raw-fetch pattern so a 409
`NODE_LABEL_CONFLICT` body deserialises into `CanvasConflictError`
with `nodeId` + `conflictWith` intact.

**Routes (apps/web/src/api/\_routes.ts)**

```ts
canvasNodeContent: (canvasId: string, nodeId: string) =>
  `/canvas/${enc(canvasId)}/nodes/${enc(nodeId)}/content`,
```

**Content-field routing (apps/web/src/store/canvasStore.ts)**

Add a single constant:

```ts
const NODE_CONTENT_KEYS = new Set<string>([
  'content',
  'label',
  'labelSource',
  'src',
  'summary',
  'keywords',
  'provenance',
]);
```

Hook into `updateNodeData` / `dispatchUiIntent` so any patch
containing one of these keys also marks the node dirty for content
flush. Pure structure patches (position, size, parentId, type) do not
touch the content queue.

**Per-node debounced flush**

Module-scoped state:

```ts
const NODE_CONTENT_DEBOUNCE_MS = 500;
const nodeContentTimers = new Map<string, ReturnType<typeof setTimeout>>();
const nodeContentInFlight = new Map<string, Promise<void>>();
```

Scheduler:

- `scheduleNodeContentSave(nodeId)` debounces; on fire, calls
  `serializedFlush(nodeId)`.
- `serializedFlush` chains onto any in-flight promise so each node
  has at most **one PUT in flight at a time**. The next scheduled
  patch always reads `useCanvasStore.getState()` at flush time, so
  trailing edits collapse into a single later PUT — never a queue of
  pending bodies.
- A successful response patches the store's label via
  `_setStateNoAutosave` when the server resolved a different one
  (agent auto-dedupe). No structure autosave is scheduled — label
  no longer lives in `canvas.json`, so the in-memory store is the
  only consumer that needs the corrected value.
- A `CanvasConflictError` with `code === 'NODE_LABEL_CONFLICT'`
  rolls back the offending label patch in the store and surfaces the
  existing alert UX through `tryRename`'s error path (same code path
  as today, different fetch site).

**Structure PUT payload slim-down**

Inside `saveCanvas`, build the request `state.nodes` by deep-copying
each node and deleting every `NODE_CONTENT_KEYS` member from
`node.data`. No exceptions — label is content, structure is
everything else.

Drop the `response.renamedNodes` reconcile block; it no longer
exists.

**`tryRename(kind: 'node')`**

1. Local sibling pre-check (keep — same case-insensitive `normalize`).
2. `updateNodeData(id, { label, labelSource: 'user' })`.
3. Await the in-flight content PUT for that nodeId (via
   `nodeContentInFlight.get(nodeId)`); on `CanvasConflictError`
   `NODE_LABEL_CONFLICT`, revert the label patch and `window.alert`
   the user — exactly today's UX.

User-perceived rename latency: down from "next 1s autosave debounce"
to "next 500ms content debounce + one RTT".

**Preprocess pipeline**

[`apps/web/src/handler/canvasCommand/preprocess.ts`](../apps/web/src/handler/canvasCommand/preprocess.ts)
already calls `patchNodeSilent` for `summary` / `keywords` /
`suggestedLabel`. After this split those calls still trigger
`NODE_CONTENT_KEYS` dirty marking → next content flush persists them.
No direct API call from the preprocess handler; the existing flush
queue handles it.

**Editor components**

`TextNode`, `NotePreview`, `ExpandedNodePanel`, `WebNode`, `PDFNode`,
`MilkdownEditor` all go through `updateNodeData`. **Zero component
changes**.

### What Does NOT Change

- `DELETE /:canvasId/nodes/:nodeId` — unchanged (unlinks `.md`, no
  `canvas.json` touch).
- `POST /:canvasId/nodes/:nodeId/preprocess` — unchanged.
- `GET /:canvasId` — unchanged; still hydrates content into the
  response state.
- Canvas events (`/events`), import/export, artifact endpoints —
  unchanged.
- Agent `canvas_commands` tool — unchanged; content commands still
  flow through the client executor into the store, then split
  naturally across structure + content endpoints on autosave.

## PR Sequencing

### PR-A: Server-only (backward-compatible)

1. Add `putNodeContentBodySchema`, `PutNodeContentRequest`,
   `PutNodeContentResponse`, `GetNodeContentResponse` to
   `packages/shared/src/types/api/canvas.ts`; export from
   `packages/shared/src/index.ts`.
2. Add `PUT/GET /:canvasId/nodes/:nodeId/content` routes; extract
   `hydrateOneNode(store, nodeId, nodeType)` and use it from both the
   batch hydrate and the new GET.
3. Leave `persistAndStripNodes` exactly as today — old clients still
   work end-to-end via the batch PUT.
4. Smoke / eval: a new `apps/server/evals` case (or unit test) for
   `PUT /content` → `GET /content` round-trip including dedupe and
   `NODE_LABEL_CONFLICT`.

PR-A is independently shippable.

### PR-B: Web cutover + server slim-down

1. Add `putNodeContent` / `getNodeContent` helpers and the new route
   constant in web.
2. Implement `NODE_CONTENT_KEYS`, dirty marking, debouncer, serialized
   flush, and store wiring.
3. Slim `saveCanvas` payload (strip content keys, keep user/agent
   labels). Remove the `renamedNodes` reconcile block.
4. Rewire `tryRename('node')` to await the per-node flush.
5. Server: rename `persistAndStripNodes` → `stripNodesForCanvas`,
   delete the `.md` writes + pre-pass, and strip `label` /
   `labelSource` / `src` / `provenance` from `node.data` before
   writing `canvas.json`. Rewrite `hydrateNodeContent` to always
   read `label` from the `.md` frontmatter (one rule, no
   `labelSource` branching). Stop returning `renamedNodes`. Delete
   the `RenamedNode` type and the `renamedNodes` field on
   `PutCanvasResponse` outright.
6. Manual smoke matrix:
   - Single-tab note typing → only content PUTs hit network, no
     structure PUT during pure typing.
   - Drag + edit simultaneously → one structure PUT, one content
     PUT, interleaved without 409.
   - User rename collides → content PUT 409 → alert + revert.
   - Agent run that creates a node with body → structure PUT inserts
     stub, content PUT writes `.md`, agent label gets `" (2)"`
     suffix when needed.
7. Re-run `apps/server/evals` — should be unaffected (evals exercise
   agent reads, not the autosave path).

PR-B depends on PR-A being deployed (web hits new endpoints).

## Label is single-sourced in `.md`

A key invariant of the refactored design: **after PR-B,
`canvas.json` carries no label at all**. The `.md` frontmatter
(`label:`) plus the on-disk filename are the sole sources of truth.

### Why this works (and didn't before)

Every node type already has a sibling `.md` —
`MD_BACKED_NODE_TYPES` is `{ note, text, web, pdf, image, video,
frame }`. Text-bearing types carry a body, the others carry
frontmatter-only. So there is no "node type without `.md`" that
would need a label fallback in `canvas.json`. Today's hydrate code
already prefers `.md` label over `canvas.json` label when
`labelSource === 'auto'`; PR-B extends that preference to all label
sources, and PR-B's structure PUT stops writing the field at all.

### Consequences

| Property                         | Before split                                           | After PR-B                                               |
| -------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Number of persisted label copies | 2 (canvas.json + .md frontmatter)                      | 1 (.md frontmatter only)                                 |
| Possible drift between them      | Yes (write order, partial failure)                     | Not representable                                        |
| Hydrate label rule               | Branch on `labelSource`                                | One rule: `.md` if present, else null + `contentMissing` |
| Structure PUT contains `label`?  | Yes (for `user` / `agent` source)                      | No                                                       |
| Filename uniqueness validation   | Pre-pass inside structure PUT + writeNode strict check | Only `writeNode` strict check                            |
| Source of `NODE_LABEL_CONFLICT`  | Structure PUT or content PUT                           | Content PUT exclusively                                  |

### Transient window (in-memory only, not persisted)

During the ~500 ms before a content PUT lands, the in-memory store
holds the new label but `.md` has not yet been updated. This is
**by design** — it's exactly what "debounced autosave" means. It is
not drift between two persisted records: the only persisted record
is `.md`, and it is consistent with itself.

If the user reloads in this window:

- Structure PUT may or may not have landed.
- Content PUT may or may not have landed.
- Hydrate reads `.md` for label; whatever is there is what the user
  sees. There is no version of "a stale label in `canvas.json`
  contradicting the `.md`" because `canvas.json` does not store
  labels anymore.

### New-node UX

When a brand-new node is created and the structure PUT lands before
the content PUT:

1. `canvas.json` gains the node (id, type, geometry).
2. `.md` does not yet exist.
3. Hydrate sets `data.contentMissing = true`, `data.label = null`.
4. UI renders the existing placeholder (same path used today when a
   `.md` is deleted out-of-band).
5. Content PUT lands within one debounce + RTT (~600 ms
   typical); next hydrate — or the in-memory state of the tab that
   posted both PUTs — has the label.

This is acceptable because (a) the originating tab never sees the
placeholder (its in-memory store holds the label throughout), and
(b) in M3 multi-tab, the sibling-tab placeholder window is bounded
by the content debounce, which is also fine.

## Risks & Mitigations

| Risk                                                                                                       | Mitigation                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sibling tab (M3) reloads between structure PUT and content PUT → sees `contentMissing` placeholder briefly | Bounded by content debounce + RTT (~600 ms). Same UX path as out-of-band `.md` deletion, already styled.                                                                                                                                                     |
| Per-node flush queue grows during long offline window                                                      | `serializedFlush` collapses trailing patches into one — never queues bodies. At most one pending PUT per node.                                                                                                                                               |
| Agent creates many nodes; structure PUT lands before content PUTs                                          | Originating tab: in-memory `nodes[].data.content` covers rendering until content PUTs complete. Sibling tabs (M3): brief placeholder per node, then re-hydrate.                                                                                              |
| Old browser tab still posts `content` + expects `renamedNodes`                                             | PR-A keeps the legacy path alive (`persistAndStripNodes` still writes). PR-B drops it; old tabs that survive the deploy lose trailing content edits and any pending rename — same failure mode as today's stale-PUT, acceptable for single-user-per-machine. |
| `provenance` blob semantics                                                                                | Server treats it as opaque frontmatter; no parsing. Round-trips through `.md` frontmatter as-is.                                                                                                                                                             |
| Test debt                                                                                                  | Add a server-side round-trip test in PR-A and a web-side unit test for the debounce/serialize logic in PR-B.                                                                                                                                                 |

## Relationship to M4 (Yjs for note content)

This split is the prep step for M4. After it lands, the editor →
server write path is:

```
MilkdownEditor onChange
  → writePatch → onDataChange → updateNodeData
  → NODE_CONTENT_KEYS dirty mark + scheduleNodeContentSave
  → serializedFlush → PUT /content → store.writeNode
```

M4 swaps the transport between `scheduleNodeContentSave` and
`store.writeNode`:

```
MilkdownEditor (+ @milkdown/plugin-collab)
  → Y.Doc update via WS /canvas/:id/nodes/:nodeId/yjs
  → server Y.Doc registry: debounce 500ms
  → store.writeNode (unchanged)
```

| M4 requirement                                           | Satisfied by this split?                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Per-node sync unit                                       | ✅ endpoint already per-nodeId, URL parallel to M4's WS path                                 |
| `.md` canonical, single write entry point on server      | ✅ all content writes funnel through `store.writeNode` from one HTTP handler                 |
| Content writes free of structure `version`               | ✅ no version field in content PUT                                                           |
| Debounced flush ≈ 500ms                                  | ✅ same constant; M4 reuses it                                                               |
| Editor component contract unchanged when transport swaps | ✅ component only knows `updateNodeData`; transport lives in store                           |
| Agent `flushPendingWrites(canvasId)` before tool calls   | ✅ once Y.Doc is the only writer, flush drains a single buffer; no other write source exists |

Carry-over cost when M4 ships: the ~50 lines of
`scheduleNodeContentSave` + `nodeContentInFlight` get replaced by
Y.Doc binding. The server `PUT /content` endpoint stays as a fallback
for non-collaborative writers (agent direct calls in M2, scripts,
integration tests).

## Decision Log

- **Reuse `NODE_LABEL_CONFLICT` code**, do not invent a new
  per-endpoint code. Same semantic condition (`.md` filename
  uniqueness, strict mode), same client UX (revert + alert). Reusing
  keeps `CanvasErrorCode` minimal.
- **`canvas.json` no longer stores `label`.** `.md` frontmatter is
  the single source of truth for every node type — every type already
  has an `.md` sidecar, so there is no fallback gap. Hydrate uses one
  rule (`label = .md frontmatter`), drift between the two records is
  not representable. The new-node "label missing for ~600 ms before
  content PUT lands" window reuses the existing `contentMissing`
  placeholder.
- **Strip label validation from the structure PUT entirely.** After
  the split there is only one writer of `.md` filenames (the content
  PUT), so the batch-internal pre-pass becomes unreachable and the
  structure PUT should not retain a label uniqueness invariant it no
  longer enforces.
- **`RenamedNode` is deleted, not deprecated.** PR-B updates server
  and web atomically; the "stale tab open across deploy" failure mode
  is identical to today's stale-PUT scenario. No deprecation window
  needed for a single-user-per-machine product.
- **No new error code for the GET endpoint.** Missing canvas → 404;
  missing node → 200 with `contentMissing: true` (matches today's
  batch hydrate semantics).
- **`scheduleNodeContentSave` uses a per-node 500ms debounce**, not
  the canvas 1s autosave. Content edits feel snappier than structure
  drags; matches the editor-input cadence.
