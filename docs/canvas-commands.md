# CanvasCommand Reference

## Command Table

| Command                      | History (undo) | Action Trace | Action Trace Type                                        | Notes                                                                                                                                                                                                                                          |
| ---------------------------- | -------------- | ------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADD_NODE`                   | ✅             | ✅           | `node_created`                                           | `nodes[0].origin` carries the creation intent: `user-created`, `user-drag-library`, `user-drag-chat`, etc.                                                                                                                                     |
| `DELETE_NODES`               | ✅             | ✅           | `nodes_deleted`                                          | One entry for the entire operation; `nodes[]` includes all deleted nodes (including cascaded child nodes).                                                                                                                                     |
| `CONNECT`                    | ✅             | ✅           | `node_connected`                                         |                                                                                                                                                                                                                                                |
| `DISCONNECT_EDGES`           | ✅             | ✅           | `edges_disconnected`                                     | One entry for the entire operation; `edges[]` contains all disconnected source/target pairs.                                                                                                                                                   |
| `MOVE_INTO_FRAME`            | ✅             | ✅           | `node_framed`                                            |                                                                                                                                                                                                                                                |
| `MOVE_OUT_OF_FRAME`          | ✅             | ✅           | `node_unframed`                                          |                                                                                                                                                                                                                                                |
| `GROUP_SELECTION_INTO_FRAME` | ✅             | ✅           | `node_created`                                           | Records the newly created frame node.                                                                                                                                                                                                          |
| `GROUP_RECT_INTO_FRAME`      | ✅             | ✅           | `node_created`                                           | Records the newly created frame node.                                                                                                                                                                                                          |
| `UNFRAME`                    | ✅             | ✅           | `frame_unframed`                                         | One entry; `frame` is the dissolved frame node, `nodes[]` contains all released child nodes.                                                                                                                                                   |
| `OPEN_EXPANDED`              | ❌             | ✅           | `node_expanded`                                          |                                                                                                                                                                                                                                                |
| `SELECT_NODES`               | ❌             | ✅           | `node_selected` / `nodes_selected`                       | Single selection records `node_selected`; multi-select (`multiSelect`) records `nodes_selected`, with `nodes[]` containing all toggled nodes.                                                                                                  |
| `RESIZE_NODE`                | ✅             | ✅           | `node_resized`                                           | The handler itself does not take a snapshot; the caller must call `store.takeSnapshot()` before the drag gesture begins. Trace carries the final `width` / `height`.                                                                           |
| `UPDATE_NODE_DATA`           | ✅             | ✅           | `node_edited`                                            | Represents a confirmed user edit; always takes a snapshot. Use `patchNodeSilent` for silent background writes.                                                                                                                                 |
| `TOGGLE_FRAME_LOCK`          | ✅             | ❌           | —                                                        |                                                                                                                                                                                                                                                |
| `REORDER_NODES`              | ✅             | ✅           | `nodes_reordered`                                        | Returns early without snapshotting if the target node does not exist. Trace carries all nodes involved in the reorder.                                                                                                                         |
| `PASTE_NODES`                | ✅             | ✅           | `node_created`                                           | `nodes[]` contains all pasted nodes with `origin: 'user-pasted'`. Unified with ADD_NODE trace; batch size > 1 signals a paste gesture.                                                                                                         |
| `ALIGN_NODES`                | ✅             | ❌           | —                                                        | Returns early without snapshotting if there are no selected nodes to align. `direction` specifies the alignment axis.                                                                                                                          |
| `SPREAD_NODES`               | ✅             | ❌           | —                                                        | Returns early without snapshotting if there are fewer than three nodes to distribute.                                                                                                                                                          |
| `NODE_DRAG_STOP`             | ✅             | ✅           | `nodes_moved` + optional `node_framed` / `node_unframed` | The handler itself does not take a snapshot; the caller must call `store.takeSnapshot()` before the drag gesture begins. Trace carries all dragged nodes. If auto-frame/unframe triggers, additional traces are pushed for each affected node. |
| `undo`                       | —              | ✅           | `canvas_undone`                                          | Recorded directly in the store's `undo()` method (not a dispatch command). No snapshot is taken; the snapshot is _consumed_ from the undo stack.                                                                                               |
| `redo`                       | —              | ✅           | `canvas_redone`                                          | Recorded directly in the store's `redo()` method (not a dispatch command). No snapshot is taken; the snapshot is _consumed_ from the redo stack.                                                                                               |

## How to Add a New Action

All command handlers live in `apps/web/src/store/canvasHandlers.ts`. Follow these steps:

1. **Define the command shape** in the `CanvasCommand` union (`canvasStore.ts`).
   Use clear, verb-noun naming: `VERB_SUBJECT` (e.g. `DELETE_NODES`, `RESIZE_NODE`).

2. **Add a handler function** in `canvasHandlers.ts` following the existing pattern:
   - Accept `(cmd: Extract<CanvasCommand, { type: 'YOUR_TYPE' }>, ctx: CanvasHandlerContext)`.
   - Take an undo snapshot with `canvasHistoryManager.takeSnapshot` **before** mutating state.
   - Record an agent-readable entry in `actionHistory` via `pushAction` so the AI agent has context about recent user activity.
   - Call `ctx.set(...)` **exactly once** at the end — multiple `set` calls cause extra re-renders and can break the autosave middleware diffing.
   - If the action creates or modifies node content that needs to be indexed in the knowledge base, call `ctx.triggerIngestion(node)` after `set`.

3. **Add the case** to the `switch` in `handleCommand` and call your new function.

4. **Expose a public store method** in `canvasStore.ts` (`RFState` + implementation) that calls `get().dispatch({ type: 'YOUR_TYPE', ... })`.

5. **Guard clauses belong in the handler** (e.g. early `return` / `break` when there is nothing to do), not in the public store method.

Cmd+I → triggerIntent()
→ getAgentContext() + screenshot
→ POST /api/intent/recognize
→ LLM 返回 [{label, actions: [{op: "ADD_NODE", tempId: "$s", ...}, {op: "CONNECT", sourceId: "$s", ...}]}]
→ IntentPopover 显示候选（含步骤链）
→ 用户点击
→ executeIntent(idx)
→ console.log 打印 actions 内容（方便 debug）
→ executeIntentActions(actions)
→ 每个 action 前 re-read getState()
→ ADD_NODE 存 tempId → realId 映射
→ CONNECT 等通过 resolveId() 解析 tempId
→ logIntentEpisode() 记录到 DB
