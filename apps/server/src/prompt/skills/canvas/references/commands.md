# Canvas Commands

Everything you need to mutate a canvas. **Load this before issuing your first `canvas_commands` call.** The mental model and read-side tools live in [`SKILL.md`](../SKILL.md); this file is purely about writes.

> **The filesystem tools are read-only.** `read`, `find`, `ls`, `grep` are not allowed to mutate the canvas, and there is no `write` / `edit_file` / `rm` companion. Every change — creating nodes, editing labels, moving things into a frame, drawing edges, changing accents — flows through the **single tool** `canvas_commands`. The server applies the batch atomically and keeps the on-disk node files in sync for you.

> **Schema is the source of truth.** Field names, types, and required parameters live on the `canvas_commands` schema. This file explains _which command to pick_ and _how to compose them_.

## 1. The one entry point: `canvas_commands`

`canvas_commands` takes one batch of `CanvasCommand` objects and applies them as a **single atomic undo step**. One batch per user intent — fewer batches means fewer re-renders and a cleaner undo history.

## 2. Command catalogue

**Structural mutations (nodes & edges)**

- **CREATE_NODES** — create one or more nodes. If you supply an explicit `position` it is honoured verbatim; omit `position` to let the force-directed engine pick a non-overlapping slot.
- **CREATE_QUESTION** — create a question node the user is expected to answer. Use this to surface follow-ups instead of asking in chat.
- **DELETE_NODES** — remove nodes by id. Incident edges are removed automatically.
- **MERGE_NODE_DATA** — shallow-merge a patch into `node.data` (label / content / style). Style supports `accent` (palette token, top stripe + edge stroke) and `backgroundColor` on every node type; text-only style fields apply only to text nodes.
- **CONNECT_NODES** — create edges. Style fields (lineType, lineStyle, stroke, strokeWidth, direction) are optional and pulled from the edge schema.
- **DISCONNECT_EDGES** — remove edges by id or by source/target pair.
- **SET_EDGE_STYLE** — patch visual style on existing edges.

**Container / hierarchy**

- **SET_NODE_PARENT** — move nodes into a frame, or out of a frame (`parentId: null`).
- **DISSOLVE_FRAME** — ungroup a frame, keep child nodes at root.

**Layout**

- **SET_NODE_GEOMETRY** — set position and/or size on existing nodes.
- **REORDER_NODES** — change z-order (`top` / `bottom` / `{before|after: id}`).
- **ALIGN_NODES** — align selected nodes along an axis.
- **DISTRIBUTE_NODES** — even spacing across ≥3 nodes.

## 3. ID conventions

- Node IDs: `node-<uuid>` (use `crypto.randomUUID()`).
- Edge IDs: `edge-<uuid>`.
- When a later command in the same batch references a node created by an earlier command, **provide an explicit `id` on the CREATE_NODES entry** so the reference resolves.

## 4. Batch ordering

`canvas_commands` runs serially within a single call (declared order is preserved). When the LLM emits two `canvas_commands` calls in the same agent batch, pi-agent-core also serialises them — so a later call always sees the effects of the earlier one. Take advantage of this:

1. **Create** everything you need to reference (with explicit ids).
2. **Wire** it up (`CONNECT_NODES`, `SET_NODE_PARENT`).
3. **Polish** (`ALIGN_NODES`, `DISTRIBUTE_NODES`).

## 5. Style hints

**Labels & content**

- Always set a concise `data.label` on every node — it is what the user sees when zoomed out.
- For `note` nodes, `data.content` is Markdown — write substantive, well-formatted bodies.
- For `frame` nodes, set `data.label`; size the frame to enclose its children with ~40px padding.

**Accent tokens (`data.style.accent`)**

- The accent renders as a coloured stripe / shadow that stays visible at low zoom — it is the primary visual signal for "these nodes belong together".
- Use the **same accent** for every node in one logical group; use **distinct accents** to separate groups.
- Reserve `"grey"` for de-emphasised / neutral material.
- Allowed tokens are enumerated on the `CREATE_NODES` schema (`data.style.accent`, e.g. `"purple"`, `"cyan"`, `"amber"`). **Never invent hex values.**
- Apply via `CREATE_NODES` (on creation) or `MERGE_NODE_DATA` (on existing nodes); the merge is shallow on `data` so a `{ data: { style: { accent: "purple" } } }` patch leaves every other field untouched.

## See also

- [`command-cookbook.md`](command-cookbook.md) — composed batch patterns for common user intents (brainstorm, merge / synthesize, group into a frame, restyle a cluster, tidy a row, …).
- [`layout-recipes.md`](layout-recipes.md) — coordinate system, hierarchical / left-to-right / grid layouts, frames, and the row-track flowchart / roadmap recipe.
