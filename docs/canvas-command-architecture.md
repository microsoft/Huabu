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
- `AUTO_LAYOUT` computes positions from explicit scope.
- `ALIGN_NODES` aligns provided nodes without relying on selection.

Every `CanvasCommand`:

1. Must be JSON-serializable.
2. May read persistent canvas state during execution.
3. Must not depend on UI-only state (selection, clipboard, marquee, drag, viewport).
4. Must use explicit operands (node ids, frame ids, edge ids, scope).
5. Returns `applied: false` with no side effects if it cannot be applied.

### Command Catalog

See `packages/shared/src/types/canvas/command.ts` for the full 15-member discriminated union. Summary:

| Category         | Commands                                         |
| ---------------- | ------------------------------------------------ |
| Node lifecycle   | `CREATE_NODES`, `DELETE_NODES`                   |
| Node editing     | `MERGE_NODE_DATA`                                |
| Structure        | `SET_NODE_PARENT`, `DISSOLVE_FRAME`              |
| Geometry         | `SET_NODE_GEOMETRY`                              |
| Selection / view | `SET_NODE_SELECTION`, `SET_EXPANDED_NODE`        |
| Ordering         | `REORDER_NODES`                                  |
| Locking          | `SET_NODE_LOCKED`                                |
| Edge graph       | `CONNECT_NODES`, `DISCONNECT_EDGES`              |
| Algorithms       | `ALIGN_NODES`, `DISTRIBUTE_NODES`, `AUTO_LAYOUT` |

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

- `dispatchUiIntent(intent)` — resolves `CanvasUiIntent` → commands → `executeCommands()`, pushes trace to `actionHistory`.
- `executeCommands(commands)` — wraps in `CanvasExecution { source: 'ui' }`, runs executor, manages undo snapshots, commits to Zustand, runs post-effects.

## Examples

### Move Node Into Frame

Web: user drags node over frame → `NODE_DRAG_STOP` intent → resolver identifies `nodeId` + `frameId` → emits `SET_NODE_PARENT`.

Agent: emits `SET_NODE_PARENT` directly.

### Group Selection Into Frame

Web only: user clicks "Group" → `GROUP_SELECTION_INTO_FRAME` intent → resolver reads selection, computes bounds → emits `CREATE_NODES` + `SET_NODE_PARENT` + `SET_NODE_SELECTION` batch.

No shared `GROUP_SELECTION_INTO_FRAME` command exists because selection lookup is web-only.

### Agent Auto Layout

Agent emits `AUTO_LAYOUT { scope: { type: 'canvas' } }` directly — valid because it depends only on explicit scope + persisted state.

---

## TODO: Converge Agent and Web

The server-side agent tool executor (`apps/server/src/modules/agent/tools/executor.ts`) is currently independent — uses its own `executeTool()` dispatch, directly mutates state via `loadCanvasState()` / `saveCanvasState()`, and does not use `CanvasCommand` or `CanvasExecution`.

`packages/shared/src/types/intent.ts` defines a parallel `IntentAction` union (uses `op` discriminant) not yet converged with `CanvasCommand`.

### Tasks

- [ ] **Define agent-facing CanvasCommand schema on the server.** Decide whether the agent emits `CanvasCommand` JSON from the LLM tool-call layer, or whether a thin server adapter maps agent tool calls to `CanvasCommand` JSON sent to the web executor.
- [ ] **Refactor `apps/server/src/modules/agent/tools/executor.ts`.** Replace `executeTool()` dispatch so it produces `CanvasCommand[]` instead of directly mutating state.
- [ ] **Route agent commands through the web executor.** Wrap agent `CanvasCommand[]` in `CanvasExecution { source: 'agent' }` and execute via the same pipeline.
- [ ] **Converge `IntentAction` with `CanvasCommand`.** Retire or align the parallel union in `packages/shared/src/types/intent.ts`.
- [ ] **Remove duplicated domain logic from the server executor.** Delete standalone create/update/delete/connect/frame implementations once agent commands flow through the shared pipeline.
