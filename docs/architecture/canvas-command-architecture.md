# Canvas Command Architecture

## Overview

Canvas mutations use a three-layer model:

1. **`CanvasUiIntent`** — web-only user interaction semantics (`apps/web/src/handler/canvasCommand/uiIntent.ts`)
2. **`CanvasCommand`** — shared executable JSON command schema (`packages/shared/src/types/canvas/command.ts`)
3. **`CanvasExecution`** — batch/transaction boundary for validation, undo, action trace, and side effects (`packages/shared/src/types/canvas/execution.ts`)

Data flow:

1. Web gesture → `CanvasUiIntent` → resolver → `CanvasExecution` → executor
2. Agent response → `CanvasCommand[]` → `CanvasExecution` → executor
3. Executor → validate, apply, trace, snapshot, effects

`CanvasExecution.source` defaults to `ui`. Most command behavior is shared
across sources; the notable selection exception is `CREATE_NODES`: UI-created
non-`question` entries in that command become the active selection, while
agent/system-created entries and `question` entries preserve the existing
selection.

## Layer 1: CanvasUiIntent

`CanvasUiIntent` is a web-only input model for user gestures. It resolves UI-specific ambiguity (selection, clipboard, drag context, viewport position, rectangle hit-testing) into explicit `CanvasCommand` operands.

`CanvasUiIntent` must not be shared with the agent because it depends on ephemeral frontend state.

### UI intent design rules

Resolvers:

1. Read UI-only state (selection, clipboard, drag context, viewport, hit-testing).
2. Resolve ambiguous gestures into explicit operands.
3. Return `UiIntentResolution { commands, trace, ...uiEffects }`.
4. Never mutate canvas state directly.

Resolvers must not:

1. Own undo snapshots
2. Write action trace directly
3. Trigger ingestion or label resolution
4. Apply state mutations

### UI intent implementation

Types and resolvers: `apps/web/src/handler/canvasCommand/uiIntent.ts` + `apps/web/src/handler/canvasCommand/resolvers/`.

22 intent types: 8 composite gestures (need selection/clipboard/drag/viewport resolution) + 14 direct-mapping intents (thin wrappers to `CanvasCommand`). See `uiIntent.ts` for the full union.

### Post-create editing

`UiIntentResolution.editNodeId` is a transient web-only request applied after the resolved commands commit successfully. `ADD_NODES` sets it when one `note` or `text` node is created: a note opens in the expanded view and focuses its editor, while a text node enters inline editing and focuses its textarea. Batch creation leaves it unset because there is no unambiguous editor target.

The request never enters `CanvasCommand`, persisted node data, or deltas. Agent execution, SSE application, delta replay, and rejected create commands therefore cannot open a view or steal focus.

Composite intent examples:

| Intent                       | Why UI-only                                               |
| ---------------------------- | --------------------------------------------------------- |
| `GROUP_SELECTION_INTO_FRAME` | Depends on current selection                              |
| `GROUP_RECT_INTO_FRAME`      | Hit-tests a rectangle against nodes                       |
| `PASTE_CLIPBOARD`            | Depends on clipboard state and paste anchor               |
| `NODE_DRAG_STOP`             | Depends on drag session and drop target                   |
| `SELECT_NODES`               | Resolves modifier-key mode (`replace` / `toggle` / `add`) |

## Layer 2: CanvasCommand

`CanvasCommand` is the shared executable command schema. It is the only command type the executor accepts. Both web and agent converge to this schema.

### Command design rules

`CanvasCommand` is the smallest shared executable domain instruction (not the smallest state diff). A command may own deterministic domain behavior inside execution:

- `DELETE_NODES` automatically removes incident edges.
- `SET_NODE_PARENT` rejects invalid targets or cycles.
- `CONNECT_NODES` rejects the command (`applied: false`, `reason: 'invalid-target'`) when any edge endpoint is not a live node — it never silently drops the edge.
- `ALIGN_NODES` aligns provided nodes without relying on selection.

Every `CanvasCommand`:

1. Must be JSON-serializable.
2. May read persistent canvas state during execution.
3. Must not depend on UI-only state (selection, clipboard, marquee, drag, viewport).
4. Must use explicit operands (node ids, frame ids, edge ids, scope).
5. Returns `applied: false` with no side effects if it cannot be applied.

### Coordinate space (parent-local)

Node geometry on `CanvasCommand` (`CREATE_NODES.position`, `SET_NODE_GEOMETRY.position`) is **parent-local**: relative to the node's direct parent frame, or absolute canvas coordinates when the node has no parent (root-local == world). This is the single coordinate contract for every caller — web resolvers already convert gestures to parent-local before emitting commands (`resolveAddNodes` subtracts the target frame's absolute origin), and the agent tool schema mirrors it. There is no absolute→relative adapter between the tool boundary and the executor.

The executor interprets the submitted `position` in that local space; a subsequent frame-fit or structured-layout pass may then normalize the persisted local value (e.g. a hug frame moves its origin and rewrites children's locals to preserve their world placement; a `column`/`row` frame re-slots children and treats `position` only as an intra-track sort key). So the contract is "interpret the input as parent-local", not "persist the numeric input verbatim". The agent-facing read side exposes the same `position` plus a read-only resolved `absolutePosition`.

### Command Catalog

See `packages/shared/src/types/canvas/command.ts` for the full discriminated union. Summary:

| Category         | Commands                                                |
| ---------------- | ------------------------------------------------------- |
| Node lifecycle   | `CREATE_NODES`, `DELETE_NODES`                          |
| Node editing     | `MERGE_NODE_DATA`, `CHANGE_NODE_TYPE`                   |
| Structure        | `SET_NODE_PARENT`, `DISSOLVE_FRAME`, `SET_FRAME_LAYOUT` |
| Geometry         | `SET_NODE_GEOMETRY`                                     |
| Selection / view | `SET_NODE_SELECTION`                                    |
| Ordering         | `REORDER_NODES`                                         |
| Locking          | `SET_NODE_LOCKED`                                       |
| Edge graph       | `CONNECT_NODES`, `DISCONNECT_EDGES`, `SET_EDGE_STYLE`   |
| Algorithms       | `ALIGN_NODES`, `DISTRIBUTE_NODES`                       |

Geometry commands preserve each node type's sizing model. `text` and
`question` nodes are always content-height nodes: `CREATE_NODES`,
`SET_NODE_GEOMETRY`, and `CHANGE_NODE_TYPE` preserve/write their top-level
`style.width` but do not persist top-level `style.height`. Use
`data.style.fontSize` to change their rendered scale. `note` nodes are
different: they may either clear top-level `style.height` for auto height or pin
it for fixed-height notes.

### IDs

Node ids use `node-<uuid>`, edge ids use `edge-<uuid>`.

- **Web / UI callers** mint ids up front and build the whole batch client-side, so a later command in the same batch can reference an earlier `CREATE_NODES` entry by its explicit id (each command sees prior commands' state — see Execution Semantics).
- **The agent path is different.** The LLM writes every command's arguments before it can observe any result, and reusing a hand-written id across separate runs collides with nodes created earlier. So on the server-applied path the `space_commands` handler (`canvas-write.ts`) **strips any `id`** off `CREATE_NODES` / `CONNECT_NODES` entries before execution; `preAssignIds` (`canvas-executor.ts`) then assigns a unique id to every id-less entry, and the executor echoes each created node's id (and label) in `results[].nodes`. To connect or reparent freshly created nodes, the agent reads those ids and issues a **follow-up** `space_commands` call in the next turn. This is why the operate prompt tells the agent to split dependent operations across calls rather than self-reference invented ids in one batch.
- **Sketch is a normal server-applied writer.** The sketch pipeline (`origin.type === 'sketch-recognized'`) runs through `executeOnServer` + broadcast like every other agent path: `recognizeSketchCommands` attributes the batch to a synthetic `threadId` (with `computeChanges`), so the mutation is applied + persisted server-side, broadcast to every tab, and produces revertible change records. The on-canvas sketch overlay drives Keep / Revert / Preview off those records (the same machinery as the chat `ChangeReviewCard`). So sketch reads real ids from `results[].nodes` and self-references created nodes (e.g. circle-to-group's new frame) via the standard omit-id / follow-up-call pattern — there is no id carve-out.

## Layer 3: CanvasExecution

`CanvasExecution` is the runtime batch/transaction layer. It defines:

1. Which commands validate and execute together
2. Which work collapses into a single undo step
3. Which action trace entries belong to the same action
4. Which side effects run after commit

### Why a Separate Layer

`CanvasUiIntent` is too early for undo/trace (web-only). `CanvasCommand` is too small (one logical action often spans multiple commands — e.g., group-into-frame = create frame + parent nodes + select frame).

### Execution Semantics

1. Process commands sequentially; each command sees state from prior commands.
2. Validate each command. Commands that fail return `applied: false`.
3. If no command changes state, commit nothing.
4. If any command changes state, take one undo snapshot and commit once.
5. Run post-commit effects.

### Execution implementation

The engine is shared, in `packages/shared/src/canvas-engine/`:

- `executor.ts` — `executeCanvasCommands(execution, state) -> ExecutorOutput`
- `commands/` — one handler per command type (17) + `index.ts` (`HANDLERS` registry + `COMMAND_META`) + `types.ts`
- `postEffects.ts` — pure post-commit effects (edge reroute)
- `interfaces.ts` — `CanvasReadState`, `CanvasWriteResult`; `delta.ts` / `diff.ts` — self-inverting delta types

Web-only pieces stay in `apps/web/src/handler/canvasCommand/`: `uiIntent.ts`, `resolvers/`, `preprocess.ts`, `postEffects.web.ts` (transition cleanup, deferred frame-fit, history snapshot, preprocessing trigger).

### Store Integration

`canvasStore.ts` exposes two internal methods:

- `dispatchUiIntent(intent)` — resolves `CanvasUiIntent` → commands → `executeCommands()`, pushes trace to the module-scoped `intentActionWindow` (kept outside Zustand to avoid a second store notification per click) and mirrors it into `canvasEvents` for the server-bound log. The window itself is a stopgap that the eventual server-side memory pipeline will replace — see `apps/web/src/store/canvasStore/intentActionWindow.ts`.
- `executeCommands(commands)` — wraps in `CanvasExecution { source: 'ui' }`, runs executor, manages undo snapshots, commits to Zustand, runs post-effects.

## Examples

### Move Node Into Frame

Web: user drags node over frame → `NODE_DRAG_STOP` intent → resolver identifies `nodeId` + `frameId` → emits `SET_NODE_PARENT`.

Agent: emits `SET_NODE_PARENT` directly.

### Group Selection Into Frame

Web only: user clicks "Group" → `GROUP_SELECTION_INTO_FRAME` intent → resolver reads selection, computes bounds → emits `CREATE_NODES` + `SET_NODE_PARENT` + `SET_NODE_SELECTION` batch.

No shared `GROUP_SELECTION_INTO_FRAME` command exists because selection lookup is web-only.

---

## Agent-Side Implementation

Agent and web now converge on the same `CanvasCommand` pipeline. The server never applies canvas mutations directly.

### Agent Command Schema

The agent exposes a single `space_commands` tool (`apps/server/src/modules/agent/tools/definitions.ts`). Its parameter schema is a TypeBox-validated subset of `CanvasCommand` — the agent-allowed command types (excludes UI-only commands `SET_NODE_LOCKED`, `SET_NODE_SELECTION`, `CHANGE_NODE_TYPE`).

The LLM emits `CanvasCommand` JSON directly from the tool-call layer; no server adapter is needed.

### Server Executor

`apps/server/src/modules/agent/tools/handlers/canvas-write.ts` handles `space_commands`: it injects `NodeOrigin` into `CREATE_NODES` then calls `executeOnServer()` ([canvas-executor.ts](../../apps/server/src/modules/canvas/canvas-executor.ts)) — the **command batch executes on the server** through the shared engine, persists `space.json` + node `.md` sidecars, appends one `delta-log.jsonl` row, and returns the structural deltas + per-command results. The LLM gets real success/error feedback. (`sketch-recognized` origin is the exception: it still returns commands to the client for the Accept/Revert overlay.)

Before the shared engine applies an agent batch, `importForeignNodeSources` normalizes `src` on both `CREATE_NODES` and `MERGE_NODE_DATA`. Media-node remote URLs and canvas-local files are imported into `.artifacts/`; for `web`, only canvas-local `.html` files are imported (uploads staged under `.upload/` are reclaimed), while live `http(s)://` and self-contained `data:` URLs remain verbatim. A local Web source with another extension is left unchanged and its staged file is not reclaimed.

Same engine runs both sides; the only authority is the server. `POST /api/canvas/:canvasId/execute` is the shared entry, guarded by a per-canvas mutex (headless executor, M2).

Two properties make the agent loop self-correcting:

- **Per-command outcomes are visible.** Each command reports `applied` and, on failure, a typed `reason` in `results[]` (e.g. `CONNECT_NODES` → `invalid-target` when an endpoint is missing, `SET_NODE_PARENT` → `invalid-target` / `invalid-parent`). Commands are validated independently — the version bumps only if at least one command changed state; an all-rejected batch is a no-op (`toVersion === fromVersion`).
- **Created ids come back.** `results[].nodes` echoes the server-assigned id (and label) of every node a `CREATE_NODES` command created, so the next turn can wire them up with real ids instead of invented ones.

### Web-Side Apply

The web client receives the server's deltas (via tool-result + SSE broadcast) and applies them with `applyDeltas` — no local re-execution. Version-gated (`localVersion >= toVersion` skips). UI gestures still run the engine locally for optimistic feedback then POST to `/execute`; agent-originated batches are pure apply.

### IntentAction Convergence

The parallel `IntentAction` union has been removed from `packages/shared/src/types/intent.ts`. That module now only contains intent _recognition_ types (`IntentCandidate`, `IntentEpisode`, `IntentRequest`, `IntentResponse`).

## Code entry points

| File                                                                                                                                       | Responsibility                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [`apps/web/src/handler/canvasCommand/uiIntent.ts`](../../apps/web/src/handler/canvasCommand/uiIntent.ts)                                   | Web-only intent and resolution contracts, including transient UI effects.             |
| [`apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts`](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts) | Materialize user-created nodes and choose an unambiguous post-create edit target.     |
| [`apps/web/src/store/canvasStore.ts`](../../apps/web/src/store/canvasStore.ts)                                                             | Execute resolved commands and map post-create editing to expanded or inline UI state. |
| [`apps/web/src/components/Nodes/note/NotePreview.tsx`](../../apps/web/src/components/Nodes/note/NotePreview.tsx)                           | Focus the editable note surface when expanded-view focus is requested.                |
| [`apps/web/src/components/Nodes/text/TextNode.tsx`](../../apps/web/src/components/Nodes/text/TextNode.tsx)                                 | Consume inline-edit requests and focus the text textarea.                             |
| [`packages/shared/src/canvas-engine/executor.ts`](../../packages/shared/src/canvas-engine/executor.ts)                                     | Execute host-agnostic canvas commands without web UI state.                           |
