# Command Cookbook

Composed `space_commands` sequences for common user intents. When a step needs the **id of a node an earlier step created**, it goes in a **follow-up call** (a command can't reference a node that doesn't exist yet — the `space_commands` tool description states the dependency rule); the recipes below mark those splits. Independent steps stay in one call. Every `CREATE_NODES` entry needs an **explicit `position`**; node ids, by contrast, are **assigned by the server** and read back from `results[].nodes`.

> **Schema is the source of truth.** Field names below come from the `space_commands` schemas; this file is about _which commands to compose_, not which fields to type.

## Quick patterns

| Intent                                 | Command sequence (`⇒` = follow-up call using returned ids)                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Group existing nodes into a frame      | `CREATE_NODES` (frame) `⇒` `SET_NODE_PARENT` (children → new frame)                                                                             |
| Brainstorm from a source               | `CREATE_NODES` (multiple ideas) `⇒` `CONNECT_NODES` (each → source)                                                                             |
| Merge / synthesize                     | `read("nodes/<filename>.md")` for inputs → `CREATE_NODES` (synthesised note) `⇒` `DELETE_NODES` (originals) + `CONNECT_NODES` (link to context) |
| Restyle a cluster                      | `MERGE_NODE_DATA` with `style.accent` on each member (one call)                                                                                 |
| Tidy a row of nodes                    | `ALIGN_NODES` (axis) → `DISTRIBUTE_NODES` (one call)                                                                                            |
| Convert a frame back to siblings       | `DISSOLVE_FRAME`                                                                                                                                |
| Move a node into a frame               | `SET_NODE_PARENT { nodeId, parentId }`                                                                                                          |
| Detach a node from its frame           | `SET_NODE_PARENT { nodeId, parentId: null } `                                                                                                   |
| Add standalone nodes to existing Space | `inspect_nodes`(anchor) → `CREATE_NODES` (root, no `parentId`) with position = anchor.absolutePosition + (anchor.size.width + 100, 0).          |

## Recipe: brainstorm from a source

Goal: turn one node into a fan of related ideas.

1. `read("nodes/<filename>.md")` if you need its actual content.
2. Create call — `CREATE_NODES`: N idea nodes with explicit positions placed in a fan around the source. Same `style.accent` so they read as a group. Read the assigned ids back from `results[].nodes`.
3. Follow-up call — `CONNECT_NODES`: one edge per idea, source → idea, using the ids from step 2. Use `direction: "forward"` if the cause→effect direction is obvious.
4. Optional polish: `ALIGN_NODES` if the fan should sit on a clean line, then `DISTRIBUTE_NODES` (can ride along with step 3).

## Recipe: merge / synthesise N notes into one

Goal: replace a noisy cluster with a single distilled note.

1. `read("nodes/<filename>.md")` for **every** input — synthesis must be grounded in the actual text, not the labels.
2. Create call — `CREATE_NODES`: one synthesised `note` with substantive Markdown body and a clear label. Position near the cluster centroid (use the outline you fetched when entering the Space). Read its id back from `results[].nodes`.
3. Follow-up call — `DELETE_NODES` the originals, and `CONNECT_NODES` to link the new note (by its returned id) to whichever upstream context still applies (e.g. the source the originals were derived from).
4. If the user asked to "keep the originals", skip `DELETE_NODES` and instead `CONNECT_NODES` from each original to the synthesised note.

## Recipe: organise a cluster into a labelled frame

Goal: take a loose group of nodes and put them in a frame with a meaningful title.

1. Use `inspect_nodes({ inSameClusterAs: "<anchorId>" })` (or `inRect` if you have a region) to enumerate members and pick a bounding box.
2. Create call — `CREATE_NODES`: one `frame`, position = top-left of the bbox minus ~40px padding, size = bbox + ~80px padding. Set `data.label` to a meaningful theme name. Read the frame id back from `results[].nodes`.
3. Follow-up call — `SET_NODE_PARENT`: each member → the new frame (by its returned id).
4. Optional: `MERGE_NODE_DATA` to give every member the same `style.accent` for visual cohesion with the frame (can ride along with step 3, since members already exist).

## Recipe: tidy a row / column

Goal: pixel-perfect alignment after manual placement.

Single call:

1. `ALIGN_NODES` — pick the axis (`top`, `middle-h`, `bottom`, `left`, `center-v`, `right`) that makes the row read straight.
2. `DISTRIBUTE_NODES` — only meaningful for ≥3 nodes; pick the same axis as the alignment.

## Recipe: redirect / rewire a connection

Goal: change what an edge connects to without losing visual continuity.

Single call (both endpoints already exist):

1. `DISCONNECT_EDGES` — remove the old edge by id (look it up via `inspect_nodes({ connectedTo: { id } })` if you only have the endpoint).
2. `CONNECT_NODES` — create the replacement, copying any meaningful style fields (lineStyle, direction) from the original.

## Recipe: detach a single node from a frame

Goal: lift one child out of a frame into the root Space.

Single `SET_NODE_PARENT { nodeId: "<child>", parentId: null }`. Keeps the node's absolute position; do not also call `SET_NODE_GEOMETRY` unless you specifically want to move it.

## Anti-patterns

- **Splitting _independent_ commands needlessly.** If commands don't depend on each other's new ids (creating several unrelated nodes, restyling a cluster, aligning a row), keep them in one call — fewer re-renders. Only split when there's a real id dependency.
- **Guessing ids for existing nodes/edges.** Look them up via `inspect_nodes` / `inspect_edges` — don't guess.
- **Restyling via `MERGE_NODE_DATA` with `data: { style: { accent: ... } }` plus other fields you did not mean to touch.** Merge is shallow on `data` — keep the patch minimal and explicit.
