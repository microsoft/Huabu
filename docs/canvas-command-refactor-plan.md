# Canvas Command Refactor Plan

## Goal

Refactor canvas mutations into a three-layer model:

1. `CanvasUiIntent`: web-only user interaction semantics
2. `CanvasCommand`: shared executable JSON command schema for web and agent
3. `CanvasExecution`: the batch or transaction boundary for validation, undo, action trace, and side effects

The end state should be:

1. The agent emits `CanvasCommand` JSON directly.
2. The web layer resolves UI gestures into the same `CanvasCommand` JSON.
3. The unified `handle` layer executes only `CanvasCommand`.
4. Undo, redo, action trace, and post-commit effects are managed at the `CanvasExecution` level.

## Core Decision

`CanvasCommand` remains the final shared executable name.

There are only two input layers:

1. `CanvasUiIntent` for the web
2. `CanvasCommand` for both web and agent

There is no separate long-lived `LegacyCanvasCommand` layer. Temporary compatibility code may exist during migration, but it should remain implementation detail rather than architecture.

## Layer 1: CanvasUiIntent

`CanvasUiIntent` is a web-only input model for user gestures.

Its job is to answer UI-specific questions before the unified `handle` layer is called.

Examples of UI-specific questions:

1. Which nodes are currently selected?
2. Which nodes fall inside a marquee rectangle?
3. Which frame is the current drop target?
4. What is the current clipboard payload?
5. What is the viewport-relative insertion point?

`CanvasUiIntent` must not be shared with the agent because it depends on ephemeral frontend state.

### What Belongs in CanvasUiIntent

Examples of valid web-only intents:

| Ui Intent                                       | Why it is UI-only                                        |
| ----------------------------------------------- | -------------------------------------------------------- |
| `GROUP_SELECTION_INTO_FRAME`                    | Depends on the current selection state                   |
| `GROUP_RECT_INTO_FRAME`                         | Depends on hit-testing a rectangle against current nodes |
| `PASTE_CLIPBOARD`                               | Depends on clipboard state and paste anchor              |
| `NODE_DRAG_STOP`                                | Depends on drag session state and drop target analysis   |
| `SELECT_NODES` with replace or toggle semantics | Depends on modifier keys and current selection           |
| `ADD_NODE_FROM_TOOLBAR`                         | Depends on viewport insertion heuristics                 |

### What CanvasUiIntent Must Do

The web resolver layer should:

1. Read UI-only state such as selection, clipboard, drag context, viewport position, and rectangle hit-testing.
2. Resolve ambiguous user gestures into explicit operands.
3. Produce one `CanvasExecution` containing one or more `CanvasCommand` items.
4. Never mutate canvas state directly.

### What CanvasUiIntent Must Not Do

The web resolver layer should not:

1. Own undo snapshots
2. Write action trace directly
3. Trigger ingestion or label resolution
4. Apply state mutations directly
5. Define shared command semantics

## Layer 2: CanvasCommand

`CanvasCommand` is the shared executable command schema.

It is the only command type that the unified `handle` layer should accept.

Both the web and the agent should converge to this schema.

### What CanvasCommand Means

`CanvasCommand` is not the smallest possible state diff.

It is the smallest shared executable domain instruction.

That means a command may still own deterministic domain behavior inside `handle`.

Examples:

1. `DELETE_NODES` should automatically remove incident edges.
2. `SET_NODE_PARENT` should reject invalid targets or cycles.
3. `AUTO_LAYOUT` should compute positions from explicit scope.
4. `ALIGN_NODES` should align the provided nodes without relying on current selection.

`SET_NODE_PARENT` should apply one shared `parentId` to one explicit list of `nodeIds`. If a batch needs different target parents, it should emit multiple `SET_NODE_PARENT` commands.

### Rules for CanvasCommand

Every `CanvasCommand` should follow these rules:

1. It must be JSON-serializable.
2. It may read persistent canvas state during execution.
3. It must not depend on UI-only state such as selection, clipboard, marquee rectangles, drag session state, or viewport-only defaults.
4. Its operands must be explicit: node ids, frame ids, edge ids, target scope, or batch-local refs.
5. It may own deterministic structural cleanup and invariant enforcement.
6. If it cannot be applied, it must return `applied: false` with no side effects.

### Layout and Alignment in CanvasCommand

Yes, layout and alignment belong in `CanvasCommand` when their scope is explicit.

They are valid shared commands because:

1. The agent may legitimately ask the canvas to align or auto-layout nodes.
2. The execution only depends on persisted canvas state plus explicit payload.
3. They do not require UI-only context when node ids or layout scope are provided.

Good examples:

1. `ALIGN_NODES { nodeIds, direction }`
2. `DISTRIBUTE_NODES { nodeIds, axis }`
3. `AUTO_LAYOUT { scope: 'canvas' }`
4. `AUTO_LAYOUT { scope: 'frame', frameId }`

Bad examples:

1. `ALIGN_SELECTED_NODES`
2. `LAYOUT_CURRENT_SELECTION`
3. `MOVE_INTO_HOVERED_FRAME`

Those are UI intents, not shared commands.

### Suggested CanvasCommand Catalog

This is the recommended shared command set.

| Category          | Command              | Purpose                                              | Notes                                                                                    |
| ----------------- | -------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Node lifecycle    | `CREATE_NODES`       | Create one or more nodes                             | Supports explicit ids or batch-local temp refs                                           |
| Node lifecycle    | `DELETE_NODES`       | Delete one or more nodes                             | Owns deterministic cleanup such as incident edge removal and optional descendant cascade |
| Node editing      | `MERGE_NODE_DATA`    | Shallow-merge `node.data` fields                     | No JSON Patch or deep merge semantics                                                    |
| Structure         | `SET_NODE_PARENT`    | Move one or more nodes under a frame or back to root | Applies one shared `parentId` to the provided `nodeIds`                                  |
| Structure         | `DISSOLVE_FRAME`     | Remove a frame while releasing its children          | Valid shared command because `frameId` is explicit                                       |
| Geometry          | `SET_NODE_GEOMETRY`  | Set explicit position and or size                    | Use for direct geometry writes                                                           |
| Selection or view | `SET_NODE_SELECTION` | Replace the selected set                             | The final selection set must already be resolved                                         |
| Selection or view | `SET_EXPANDED_NODE`  | Open or close the expanded node                      | UI state, but still executable from an explicit payload                                  |
| Ordering          | `SET_NODE_ORDER`     | Apply explicit render order                          | Avoid overloaded reorder payloads                                                        |
| Locking           | `SET_NODE_LOCKED`    | Set locked state explicitly                          | Prefer explicit booleans over toggle semantics                                           |
| Edge graph        | `CONNECT_NODES`      | Create one or more edges                             | Supports explicit source and target refs                                                 |
| Edge graph        | `DISCONNECT_EDGES`   | Remove one or more edges                             | Remove by edge id or explicit edge descriptors                                           |
| Algorithms        | `ALIGN_NODES`        | Align nodes by an explicit set of ids                | Does not depend on current selection                                                     |
| Algorithms        | `DISTRIBUTE_NODES`   | Spread nodes along an explicit axis                  | Same                                                                                     |
| Algorithms        | `AUTO_LAYOUT`        | Run layout on explicit scope                         | Currently supports `canvas` and `frame` scopes; `animate` is the only supported option.  |

### Explicit IDs for Agent-Created Objects

The shared command schema should use the same prefixed string id style as the rest of the app.

That means:

1. Node ids use the standard `node-<uuid>` format.
2. Edge ids use the standard `edge-<uuid>` format.
3. If later commands in the same batch need to reference a newly created node, the caller should provide the explicit node id up front in `CREATE_NODES`.

This allows a batch like:

```json
{
  "source": "agent",
  "commands": [
    {
      "type": "CREATE_NODES",
      "nodes": [
        {
          "id": "node-11111111-1111-4111-8111-111111111111",
          "nodeType": "note",
          "data": { "label": "Topic" },
          "position": { "x": 100, "y": 120 }
        }
      ]
    },
    {
      "type": "CREATE_NODES",
      "nodes": [
        {
          "id": "node-22222222-2222-4222-8222-222222222222",
          "nodeType": "note",
          "data": { "label": "Detail" },
          "position": { "x": 260, "y": 120 }
        }
      ]
    },
    {
      "type": "CONNECT_NODES",
      "edges": [
        {
          "source": "node-11111111-1111-4111-8111-111111111111",
          "target": "node-22222222-2222-4222-8222-222222222222"
        }
      ]
    },
    {
      "type": "ALIGN_NODES",
      "nodeIds": [
        "node-11111111-1111-4111-8111-111111111111",
        "node-22222222-2222-4222-8222-222222222222"
      ],
      "direction": "top"
    }
  ]
}
```

## Layer 3: CanvasExecution

`CanvasExecution` is the runtime batch or transaction layer.

It is not another input language.

It is the boundary that tells the system:

1. Which commands should be validated and executed together
2. Which work should collapse into a single undo step
3. Which action trace entries belong to the same user or agent action
4. Which side effects should run after the batch commits

### Why CanvasExecution Exists

`CanvasUiIntent` is too early for undo and trace because it only exists on the web.

`CanvasCommand` is too small for undo and trace because one logical action often contains multiple commands.

Examples:

1. Group selection into frame resolves to create frame, parent nodes into frame, and select frame.
2. Agent creates two nodes and connects them in one response.
3. Drag-stop may yield geometry changes plus parent changes.

All of those should usually become one execution boundary.

### What CanvasExecution Must Do

`CanvasExecution` should:

1. Carry the execution source, such as `ui`, `agent`, or `system`.
2. Carry the resolved command batch.
3. Resolve temp refs within the batch.
4. Validate each command against current state.
5. Take one undo snapshot when needed.
6. Apply all accepted commands in memory.
7. Commit resulting state once.
8. Generate command results.
9. Record action trace for the batch.
10. Run post-commit effects such as ingestion, label resolution, delete bookkeeping, and edge rerouting.

### Suggested Shapes

```ts
type CanvasExecutionSource = 'ui' | 'agent' | 'system';

type CanvasExecution = {
  source: CanvasExecutionSource;
  originUiIntent?: string;
  commands: CanvasCommand[];
};

type CanvasCommandResult = {
  command: CanvasCommand;
  applied: boolean;
  reason?:
    | 'no-op'
    | 'not-found'
    | 'invalid-parent'
    | 'invalid-target'
    | 'cycle';
};

type CanvasExecutionResult = {
  results: CanvasCommandResult[];
  actionTrace: RecentAction[];
};
```

### Execution Semantics

The executor should behave like this:

1. Load current canvas state.
2. Resolve batch-local refs.
3. Validate commands in order.
4. Apply only commands that pass validation.
5. If no command changes state, commit nothing and run no side effects.
6. If at least one command changes state, take one snapshot and commit once.
7. Generate action trace at the batch level.
8. Run ordered post-commit effects.

## How the Three Layers Work Together

### Web Path

1. User performs a gesture.
2. The web layer creates a `CanvasUiIntent`.
3. A UI intent resolver reads selection, clipboard, rectangle hit-testing, drag context, and viewport state.
4. The resolver produces a `CanvasExecution` containing explicit `CanvasCommand` items.
5. The executor validates and applies the batch.

### Agent Path

1. The agent emits `CanvasCommand` JSON directly.
2. The frontend wraps it in a `CanvasExecution` with `source: 'agent'`.
3. The executor validates and applies the batch.

### Shared Invariant

Both paths must converge before execution.

That means:

1. The executor does not care whether commands came from the web or the agent.
2. The executor only sees explicit `CanvasCommand` batches.
3. UI-only ambiguity must be resolved before execution starts.

## Examples

### Example 1: Move Node Into Frame

Web path:

1. User drags a node over a frame.
2. The UI resolver identifies `nodeId` and `frameId`.
3. It emits:

```json
{
  "source": "ui",
  "originUiIntent": "NODE_DRAG_STOP",
  "commands": [
    {
      "type": "SET_NODE_PARENT",
      "nodeIds": ["node-11111111-1111-4111-8111-111111111111"],
      "parentId": "node-99999999-9999-4999-8999-999999999999"
    }
  ]
}
```

Agent path:

1. The agent emits the same `SET_NODE_PARENT` command directly.
2. No `MOVE_INTO_FRAME` command is needed in the shared schema.

### Example 2: Group Current Selection Into Frame

Web path only:

1. User clicks "Group into frame".
2. The UI resolver reads the current selection and computes the frame bounds.
3. It emits a batch like:

```json
{
  "source": "ui",
  "originUiIntent": "GROUP_SELECTION_INTO_FRAME",
  "commands": [
    {
      "type": "CREATE_NODES",
      "nodes": [
        {
          "id": "node-33333333-3333-4333-8333-333333333333",
          "nodeType": "frame",
          "data": { "label": "Frame" },
          "position": { "x": 100, "y": 80 },
          "size": { "width": 420, "height": 240 }
        }
      ]
    },
    {
      "type": "SET_NODE_PARENT",
      "nodeIds": ["node-a", "node-b"],
      "parentId": "node-33333333-3333-4333-8333-333333333333"
    },
    {
      "type": "SET_NODE_SELECTION",
      "nodeIds": ["node-33333333-3333-4333-8333-333333333333"]
    }
  ]
}
```

There is no shared `GROUP_SELECTION_INTO_FRAME` command because the selection lookup is web-only.

### Example 3: Agent Requests Auto Layout

The agent should be able to emit:

```json
{
  "source": "agent",
  "commands": [
    {
      "type": "AUTO_LAYOUT",
      "scope": { "type": "canvas" }
    }
  ]
}
```

This is valid because it depends only on explicit scope plus current persisted canvas state.

## Suggested Module Split

| File                                            | Responsibility                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `apps/web/src/store/canvasUiIntent.ts`          | Web-only `CanvasUiIntent` types                                      |
| `apps/web/src/store/canvasUiIntentResolver.ts`  | Resolves `CanvasUiIntent` into `CanvasExecution`                     |
| `packages/shared/src/types/canvas/command.ts`   | Shared `CanvasCommand` types used by web and agent                   |
| `packages/shared/src/types/canvas/execution.ts` | Shared batch, result, and execution-layer types                      |
| `packages/shared/src/types/canvas/index.ts`     | Re-exports shared canvas command and execution types                 |
| `apps/web/src/store/canvasCommandRuntime.ts`    | Runtime interfaces for reading state and running post-commit effects |
| `apps/web/src/store/canvasCommandExecutor.ts`   | `handleCommand`, `handleCommands`, and execution logic               |
| `apps/web/src/store/canvasStore.ts`             | Zustand adapter and UI-facing methods only                           |

## What to Build in Each Layer

### CanvasUiIntent

1. Define a small web-only union for current gesture sources.
2. Move selection, marquee, clipboard, drag, and viewport logic into resolvers.
3. Make every resolver return `CanvasExecution` instead of mutating state.

### CanvasCommand

1. Define the shared JSON command union.
2. Ensure every command uses explicit operands.
3. Include `ALIGN_NODES`, `DISTRIBUTE_NODES`, and `AUTO_LAYOUT` because the agent must be able to use them.
4. Keep deterministic structural semantics inside command execution.

### CanvasExecution

1. Use batch execution as the undo or redo boundary.
2. Use batch execution as the action trace boundary.
3. Centralize snapshot policy, validation, post-commit effects, and result reporting.

## Legacy Store Command Mapping

The current `apps/web/src/store/canvasStore.ts` command union is intentionally larger than `CanvasUiIntent` because it mixes web gestures, shared executable commands, and temporary store-local convenience commands.

During migration, each legacy entry follows a migration path rather than always mapping to one single layer label. Some entries become shared `CanvasCommand` directly, some become `CanvasUiIntent` that resolve into commands, and some remain temporary store adapters until call sites finish moving.

| Current store command        | Migration path                                 | Final shape                                                               | Migration note                                                                                 |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ADD_NODE`                   | Store adapter -> `CanvasCommand`               | `CREATE_NODES`                                                            | `ADD_NODE_FROM_TOOLBAR` is the web intent; explicit node creation is the shared command.       |
| `DELETE_NODES`               | `CanvasCommand`                                | `DELETE_NODES`                                                            | Keep deterministic cleanup such as edge removal inside execution.                              |
| `CONNECT`                    | `CanvasCommand`                                | `CONNECT_NODES`                                                           | Replace single-connection payloads with explicit edge create items.                            |
| `DISCONNECT_EDGES`           | `CanvasCommand`                                | `DISCONNECT_EDGES`                                                        | Accept explicit edge ids or source-target refs.                                                |
| `MOVE_INTO_FRAME`            | `CanvasCommand`                                | `SET_NODE_PARENT { nodeIds, parentId }`                                   | Do not keep a long-lived shared `MOVE_INTO_FRAME` command.                                     |
| `MOVE_OUT_OF_FRAME`          | `CanvasCommand`                                | `SET_NODE_PARENT { nodeIds, parentId: null }`                             | Same shared structure as moving into a frame.                                                  |
| `GROUP_SELECTION_INTO_FRAME` | `CanvasUiIntent` resolver -> `CanvasExecution` | `CREATE_NODES` + `SET_NODE_PARENT` + `SET_NODE_SELECTION`                 | Selection lookup is web-only.                                                                  |
| `GROUP_RECT_INTO_FRAME`      | `CanvasUiIntent` resolver -> `CanvasExecution` | `CREATE_NODES` + `SET_NODE_PARENT` + `SET_NODE_SELECTION`                 | Rectangle hit-testing is web-only.                                                             |
| `UNFRAME`                    | `CanvasCommand`                                | `DISSOLVE_FRAME`                                                          | Explicit `frameId` makes this a valid shared command.                                          |
| `OPEN_EXPANDED`              | `CanvasCommand`                                | `SET_EXPANDED_NODE`                                                       | Open and close should use explicit payloads, including `null` for close.                       |
| `SELECT_NODES`               | `CanvasUiIntent` resolver -> `CanvasCommand`   | `SET_NODE_SELECTION`                                                      | Replace or toggle semantics are UI-only; execution should receive the final resolved set.      |
| `RESIZE_NODE`                | `CanvasCommand`                                | `SET_NODE_GEOMETRY`                                                       | Geometry writes belong in shared execution, not in a web-only command.                         |
| `TOGGLE_NODE_LOCK`           | Store adapter -> `CanvasCommand`               | `SET_NODE_LOCKED`                                                         | Toggle semantics should not survive in the shared command layer.                               |
| `REORDER_NODES`              | `CanvasCommand`                                | `SET_NODE_ORDER`                                                          | Replace overloaded swap and top-bottom payloads with one explicit ordering payload.            |
| `PASTE_NODES`                | `CanvasUiIntent` resolver -> `CanvasExecution` | `CREATE_NODES` + optional `SET_NODE_PARENT` + `SET_NODE_SELECTION`        | Clipboard contents and paste anchor are web-only inputs.                                       |
| `ALIGN_NODES`                | `CanvasUiIntent` resolver -> `CanvasCommand`   | `ALIGN_NODES { nodeIds, direction }`                                      | The current store command implicitly uses selected nodes; the shared command must be explicit. |
| `SPREAD_NODES`               | `CanvasUiIntent` resolver -> `CanvasCommand`   | `DISTRIBUTE_NODES { nodeIds, axis }`                                      | The current store command is a selected-node convenience and should not remain shared as-is.   |
| `LAYOUT_ALL`                 | `CanvasCommand`                                | `AUTO_LAYOUT { scope: { type: 'canvas' } }`                               | Shared algorithm command with explicit scope.                                                  |
| `LAYOUT_GROUP`               | `CanvasCommand`                                | `AUTO_LAYOUT { scope: { type: 'frame', frameId } }`                       | Shared algorithm command with explicit scope.                                                  |
| `NODE_DRAG_STOP`             | `CanvasUiIntent` resolver -> `CanvasExecution` | `SET_NODE_GEOMETRY` + optional `SET_NODE_PARENT` in one `CanvasExecution` | Drag session state and hover analysis are web-only.                                            |
| `UPDATE_NODE_DATA`           | `CanvasCommand`                                | `MERGE_NODE_DATA`                                                         | Preserve the current shallow-merge semantics.                                                  |

Implication: `CanvasUiIntent` should stay smaller than the legacy store command union. Many existing entries migrate directly into shared `CanvasCommand`, and some behaviors move into `CanvasExecution` rather than surviving as first-class inputs.

## Migration Plan

### Phase 1: Define the New Types

1. Introduce `CanvasUiIntent`, `CanvasCommand`, and `CanvasExecution` types.
2. Keep current store methods stable for now.
3. Add type-level support for batch-local temp refs.

### Phase 2: Introduce the Executor

1. Replace the current switch-based `handleCommand(cmd, ctx)` contract with executor functions that accept `CanvasCommand` or `CanvasExecution`.
2. Centralize validation, command results, and post-commit effects.
3. Keep one commit per execution batch.

### Phase 3: Move Web Gesture Logic Out of Command Execution

1. Convert selection-based, rectangle-based, drag-based, and clipboard-based actions into `CanvasUiIntent` resolvers.
2. Stop passing UI-derived ambiguity into the executor.
3. Make the executor accept only explicit commands.

### Phase 4: Converge Agent and Web

1. Change the agent action model so it emits `CanvasCommand` JSON directly.
2. Ensure web-generated batches and agent-generated batches go through the same executor.
3. Remove legacy store-owned command unions once all call sites migrate.

## Final Boundary

The final architecture should read like this:

1. Web gesture -> `CanvasUiIntent` -> resolver -> `CanvasExecution` -> executor
2. Agent response -> `CanvasCommand[]` -> `CanvasExecution` -> executor
3. Executor -> validate, apply, trace, snapshot, effects

Only one layer should be executable by both web and agent:

1. `CanvasCommand`

Only one layer should know about selection rectangles, modifier keys, drag hover targets, or clipboard payloads:

1. `CanvasUiIntent`

Only one layer should own undo or redo boundaries, action trace grouping, and post-commit side effects:

1. `CanvasExecution`
