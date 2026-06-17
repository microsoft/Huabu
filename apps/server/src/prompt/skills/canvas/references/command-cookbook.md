# Command Cookbook

Composed `canvas_commands` batches for common user intents. Each recipe is a single batch unless noted, and every recipe assumes the conventions in [`commands.md`](commands.md): explicit ids when later commands reference earlier creations, an explicit `position` whenever you care about layout (it is honoured verbatim), one batch per user intent.

> **Schema is the source of truth.** Field names below come from the `canvas_commands` schemas; this file is about _which commands to compose_, not which fields to type.

## Quick patterns

| Intent                                  | Batch composition                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Group existing nodes into a frame       | `CREATE_NODES` (frame) → `SET_NODE_PARENT` (children → frame)                                                                                 |
| Brainstorm from a source                | `CREATE_NODES` (multiple ideas with explicit ids) → `CONNECT_NODES` (each → source)                                                           |
| Merge / synthesize                      | `read("nodes/<filename>.md")` for inputs → `CREATE_NODES` (synthesised note) → `DELETE_NODES` (originals) → `CONNECT_NODES` (link to context) |
| Restyle a cluster                       | `MERGE_NODE_DATA` with `style.accent` on each member                                                                                          |
| Tidy a row of nodes                     | `ALIGN_NODES` (axis) → `DISTRIBUTE_NODES`                                                                                                     |
| Convert a frame back to siblings        | `DISSOLVE_FRAME`                                                                                                                              |
| Move a node into a frame                | `SET_NODE_PARENT { nodeId, parentId }`                                                                                                        |
| Detach a node from its frame            | `SET_NODE_PARENT { nodeId, parentId: null } `                                                                                                 |
| Add standalone nodes to existing canvas | `inspect_nodes`(anchor) → `CREATE_NODES` with position = anchor.position + (anchor.size.width + 100, 0).                                      |

## Recipe: brainstorm from a source

Goal: turn one node into a fan of related ideas.

1. `read("nodes/<filename>.md")` if you need its actual content.
2. Single batch:
   - `CREATE_NODES` — N idea nodes with explicit ids and explicit positions placed in a fan around the source. Same `style.accent` so they read as a group.
   - `CONNECT_NODES` — one edge per idea, source → idea. Use `direction: "forward"` if the cause→effect direction is obvious.
3. Optional polish: `ALIGN_NODES` if the fan should sit on a clean line, then `DISTRIBUTE_NODES`.

## Recipe: merge / synthesise N notes into one

Goal: replace a noisy cluster with a single distilled note.

1. `read("nodes/<filename>.md")` for **every** input — synthesis must be grounded in the actual text, not the labels.
2. Single batch:
   - `CREATE_NODES` — one synthesised `note` with substantive Markdown body and a clear label. Position near the cluster centroid (use the outline you fetched when entering the canvas).
   - `DELETE_NODES` — the originals.
   - `CONNECT_NODES` — link the new note to whichever upstream context still applies (e.g. the source the originals were derived from).
3. If the user asked to "keep the originals", skip `DELETE_NODES` and instead `CONNECT_NODES` from each original to the synthesised note.

## Recipe: organise a cluster into a labelled frame

Goal: take a loose group of nodes and put them in a frame with a meaningful title.

1. Use `inspect_nodes({ inSameClusterAs: "<anchorId>" })` (or `inRect` if you have a region) to enumerate members and pick a bounding box.
2. Single batch:
   - `CREATE_NODES` — one `frame` with explicit id, position = top-left of the bbox minus ~40px padding, size = bbox + ~80px padding. Set `data.label` to a meaningful theme name.
   - `SET_NODE_PARENT` — each member → the new frame.
3. Optional: `MERGE_NODE_DATA` to give every member the same `style.accent` for visual cohesion with the frame.

## Recipe: tidy a row / column

Goal: pixel-perfect alignment after manual placement.

Single batch:

1. `ALIGN_NODES` — pick the axis (`top`, `middle-h`, `bottom`, `left`, `center-v`, `right`) that makes the row read straight.
2. `DISTRIBUTE_NODES` — only meaningful for ≥3 nodes; pick the same axis as the alignment.

## Recipe: ask the user a question

Goal: surface a follow-up the agent cannot answer alone.

Single `CREATE_QUESTION` command. Use this instead of asking in chat — the question becomes a node in the canvas, lives next to the context that prompted it, and the user's answer flows back into the same workflow.

If the question targets an existing node, `read` that node's markdown first so the question is phrased with real context, not just the label.

## Recipe: redirect / rewire a connection

Goal: change what an edge connects to without losing visual continuity.

Single batch:

1. `DISCONNECT_EDGES` — remove the old edge by id (look it up via `inspect_nodes({ connectedTo: { id } })` if you only have the endpoint).
2. `CONNECT_NODES` — create the replacement, copying any meaningful style fields (lineStyle, direction) from the original.

## Recipe: detach a single node from a frame

Goal: lift one child out of a frame into the root canvas.

Single `SET_NODE_PARENT { nodeId: "<child>", parentId: null }`. Keeps the node's absolute position; do not also call `SET_NODE_GEOMETRY` unless you specifically want to move it.

## Anti-patterns

- **Splitting a coherent intent across two batches.** Each batch is one undo step — splitting forces the user to undo twice and may cause an intermediate render flash.
- **Omitting `position` on `CREATE_NODES` when you care about layout.** Without a `position`, the force-directed engine picks a slot and your intended geometry is lost. Always set explicit `position` for structured layouts.
- **Inventing edge ids.** Edge ids only come from existing canvas state (via `inspect_nodes` / `inspect_edges`) or from edges you create in the same batch.
- **Restyling via `MERGE_NODE_DATA` with `data: { style: { accent: ... } }` plus other fields you did not mean to touch.** Merge is shallow on `data` — keep the patch minimal and explicit.
