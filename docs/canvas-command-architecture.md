# Canvas Command Architecture

## Overview

Canvas mutations use a three-layer model:

1. **`CanvasUiIntent`** — web-only user interaction semantics (`apps/web/src/canvas/uiIntent.ts`)
2. **`CanvasCommand`** — shared executable JSON command schema (`packages/shared/src/types/canvas/command.ts`)
3. **`CanvasExecution`** — batch/transaction boundary for validation, undo, action trace, and side effects (`packages/shared/src/types/canvas/execution.ts`)

Data flow:

1. Web gesture → `CanvasUiIntent` → resolver → `CanvasExecution` → executor
2. Agent response → `CanvasCommand[]` → `CanvasExecution` → executor
3. Executor → validate, apply, trace, snapshot, effects

## Layer 1: CanvasUiIntent

`CanvasUiIntent` is a web-only input model for user gestures. It resolves UI-specific ambiguity (selection, clipboard, drag context, viewport position, rectangle hit-testing) into explicit `CanvasCommand` operands.

`CanvasUiIntent` must not be shared with the agent because it depends on ephemeral frontend state.

### Design Rules

Resolvers:

1. Read UI-only state (selection, clipboard, drag context, viewport, hit-testing).
2. Resolve ambiguous gestures into explicit operands.
3. Return `UiIntentResolution { commands, trace }`.
4. Never mutate canvas state directly.

Resolvers must not:

1. Own undo snapshots
2. Write action trace directly
3. Trigger ingestion or label resolution
4. Apply state mutations

### Implementation

Types and resolvers: `apps/web/src/canvas/uiIntent.ts` + `apps/web/src/canvas/resolvers/`.

22 intent types: 8 composite gestures (need selection/clipboard/drag/viewport resolution) + 14 direct-mapping intents (thin wrappers to `CanvasCommand`). See `uiIntent.ts` for the full union.

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

### Design Rules

`CanvasCommand` is the smallest shared executable domain instruction (not the smallest state diff). A command may own deterministic domain behavior inside execution:

- `DELETE_NODES` automatically removes incident edges.
- `SET_NODE_PARENT` rejects invalid targets or cycles.
- `ALIGN_NODES` aligns provided nodes without relying on selection.

Every `CanvasCommand`:

1. Must be JSON-serializable.
2. May read persistent canvas state during execution.
3. Must not depend on UI-only state (selection, clipboard, marquee, drag, viewport).
4. Must use explicit operands (node ids, frame ids, edge ids, scope).
5. Returns `applied: false` with no side effects if it cannot be applied.

### Command Catalog

See `packages/shared/src/types/canvas/command.ts` for the full discriminated union (currently 16 command types). Summary (non-exhaustive):

| Category         | Commands                            |
| ---------------- | ----------------------------------- |
| Node lifecycle   | `CREATE_NODES`, `DELETE_NODES`      |
| Node editing     | `MERGE_NODE_DATA`                   |
| Structure        | `SET_NODE_PARENT`, `DISSOLVE_FRAME` |
| Geometry         | `SET_NODE_GEOMETRY`                 |
| Selection / view | `SET_NODE_SELECTION`                |
| Ordering         | `REORDER_NODES`                     |
| Locking          | `SET_NODE_LOCKED`                   |
| Edge graph       | `CONNECT_NODES`, `DISCONNECT_EDGES` |
| Algorithms       | `ALIGN_NODES`, `DISTRIBUTE_NODES`   |

### Explicit IDs

Node ids use `node-<uuid>`, edge ids use `edge-<uuid>`. Callers that need to reference a newly created node in a later command within the same batch provide the explicit id in `CREATE_NODES`.

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

### Implementation

- `apps/web/src/canvas/executor.ts` — `executeCanvasCommands(execution, state) -> ExecutorOutput`
- `apps/web/src/canvas/runtime.ts` — `CanvasReadState`, `CanvasWriteResult`
- `apps/web/src/canvas/postEffects.ts` — `runPostEffects()`: edge reroute, preprocessing trigger, delete tracking, CSS transition cleanup
- `apps/web/src/canvas/commands/` — one handler file per command type (15 files) + `index.ts` (registry `HANDLERS` + `COMMAND_META`) + `types.ts`

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

The agent exposes a single `canvas_commands` tool (`apps/server/src/modules/agent/tools/definitions.ts`). Its parameter schema is a TypeBox-validated subset of `CanvasCommand` — the agent-allowed command types (excludes UI-only commands `SET_NODE_LOCKED`, `SET_NODE_SELECTION`, `CHANGE_NODE_TYPE`).

The LLM emits `CanvasCommand` JSON directly from the tool-call layer; no server adapter is needed.

### Server Executor

`apps/server/src/modules/agent/tools/executor.ts` handles `canvas_commands` via `executeCanvasCommands()`:

1. Injects `NodeOrigin` (`ai-research` or `ai-operate`) into `CREATE_NODES` commands based on agent mode.
2. Returns the validated command batch as a JSON tool result — **does not apply commands or mutate canvas state**.
3. The tool result is streamed to the web client as an SSE `tool_result` event.

### Web-Side Execution

`ChatPanel` intercepts `tool_result` events for `canvas_commands`, parses the commands, and calls `canvasStore.executeCommands(commands, 'agent')`:

1. `executeCommands()` wraps the commands in `CanvasExecution { source: 'agent' }`.
2. The shared `executeCanvasCommands()` executor (`apps/web/src/canvas/executor.ts`) processes them through the same handler registry and post-effects pipeline as UI commands.
3. Agent-originated commands skip the `beginGesture()` snapshot guard (no UI gesture involved).

### IntentAction Convergence

The parallel `IntentAction` union has been removed from `packages/shared/src/types/intent.ts`. That module now only contains intent _recognition_ types (`IntentCandidate`, `IntentEpisode`, `IntentRequest`, `IntentResponse`).
