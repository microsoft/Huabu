# Canvas Commands

Everything you need to mutate a canvas. **Load this before issuing your first `canvas_commands` call.** The mental model and read-side tools live in [`SKILL.md`](../SKILL.md); this file is purely about writes.

> **The filesystem tools are read-only.** `read`, `find`, `ls`, `grep` are not allowed to mutate the canvas, and there is no `write` / `edit_file` / `rm` companion. Every change — creating nodes, editing labels, moving things into a frame, drawing edges, changing accents — flows through the **single tool** `canvas_commands`. The server applies the commands in order, keeps the on-disk node files in sync, and reports each command's outcome in `results[]`.

> **Schema is the source of truth.** Field names, types, and required parameters live on the `canvas_commands` schema. This file explains _which command to pick_ and _how to compose them_.

## 1. The one entry point: `canvas_commands`

`canvas_commands` takes a list of `CanvasCommand` objects and applies them **in order**. Each command succeeds or fails on its own, and the result reports every command's outcome in `results[]` (with a `reason` on failure) — a command is **not** guaranteed to succeed. Group **independent** commands into one call for fewer re-renders; split **dependent** ones across calls (see §4).

## 2. Command catalogue

**Structural mutations (nodes & edges)**

- **CREATE_NODES** — create one or more nodes. **`position` is required** on every entry and is honoured verbatim; the engine no longer ships a fallback layout. Use `nodeType: "question"` to surface a follow-up question as a canvas node instead of asking in chat.
- **DELETE_NODES** — remove nodes by id. Incident edges are removed automatically.
- **MERGE_NODE_DATA** — shallow-merge a patch into `node.data` (label / content / style). `data.style.accent` is the single color knob that drives border + fill + text tint together; font fields apply only to text-bearing nodes.
- **CONNECT_NODES** — create edges. Style fields (lineType, lineStyle, stroke, strokeWidth, direction) are optional and pulled from the edge schema.
- **DISCONNECT_EDGES** — remove edges by id or by source/target pair.
- **SET_EDGE_STYLE** — patch visual style on existing edges.

> **Rewriting `content`/`src`? Read the node first.** Content rewrites are auto-guarded: if you haven't `read` the node's full body in this conversation, or it changed since you last read it, the batch is rejected and the result carries `conflicts` (with `currentContent`). Merge your change into that and re-issue. Label / style patches and new nodes are unguarded.

> **Media node `src`.** For `image` / `video` / `audio` / `pdf` / `office`, set `data.src` to a staged upload path (`upload/<name>`), a bare artifact key a tool handed you (`artifact-…` / `gen-…`), or an `https://…` URL — the server relocates / downloads the bytes into the artifact store and persists a bare key. You do **not** need to convert an upload into a key yourself.

**Container / hierarchy**

- **SET_NODE_PARENT** — move nodes into a frame, or out of a frame (`parentId: null`).
- **DISSOLVE_FRAME** — ungroup a frame, keep child nodes at root.

**Layout**

- **SET_NODE_GEOMETRY** — set position and/or size on existing nodes.
- **REORDER_NODES** — change z-order (`top` / `bottom` / `{before|after: id}`).
- **ALIGN_NODES** — align selected nodes along an axis.
- **DISTRIBUTE_NODES** — even spacing across ≥3 nodes.

## 3. ID conventions

- **The server assigns every id.** It mints a unique `node-<uuid>` / `edge-<uuid>` for each `CREATE_NODES` / `CONNECT_NODES` entry and echoes each created node's id (with its label) in `results[].nodes`. There is no `id` field to set.
- To reference a node you just created (connect it, reparent it), read its id from the create call's `results[].nodes` and use it in a **follow-up** call.

## 4. Ordering & dependencies

Within a single `canvas_commands` call the commands run in declared order, but they all share the arguments you wrote **before** seeing any result — so a command in the same call **cannot** reference a node created earlier in that same call (its server id isn't known yet). Emitting two `canvas_commands` calls in the same turn doesn't help either: you write both calls' arguments at once, so the second still can't see the first's assigned ids.

**So split dependent work across turns:**

1. **Create** the nodes (and frames) you need — the server assigns their ids.
2. Read the assigned ids from `results[].nodes`.
3. **Wire** it up in the next call (`CONNECT_NODES`, `SET_NODE_PARENT`) using those real ids.
4. **Polish** (`ALIGN_NODES`, `DISTRIBUTE_NODES`) — these only touch existing nodes, so they can ride along with any call that already has their ids.

Independent commands (create several unrelated nodes, restyle a cluster, align a row) have no such dependency — keep them in one call.

## 5. Style hints

**Labels & content**

- Always set a concise `data.label` on every node — it is what the user sees when zoomed out.
- For `note` nodes, `data.content` is Markdown — write substantive, well-formatted bodies.
- For `frame` nodes, set `data.label`; size the frame to enclose its children with ~40px padding.

**Accent tokens (`data.style.accent`)**

- The accent is the **single color knob** for a node: it drives the node's border, fill tint, and text tint together. There is no separate background-color or text-color field — do not invent one.
- Use the **same accent** for every node in one logical group; use **distinct accents** to separate groups. The grouping reads even at low zoom.
- Reserve `"grey"` for de-emphasised / neutral material.
- Allowed tokens are enumerated on the `CREATE_NODES` schema (`data.style.accent`): `"grey"`, `"white"`, `"red"`, `"orange"`, `"amber"`, `"green"`, `"blue"`, `"purple"`, or `null` to clear. **Never invent hex values or other token names.**
- Apply via `CREATE_NODES` (on creation) or `MERGE_NODE_DATA` (on existing nodes); the engine deep-merges `data.style`, so a `{ data: { style: { accent: "purple" } } }` patch leaves every other style field (`fontFamily`, `fontSize`, …) untouched.

## See also

- [`command-cookbook.md`](command-cookbook.md) — composed batch patterns for common user intents (brainstorm, merge / synthesize, group into a frame, restyle a cluster, tidy a row, …).
- [`layout-recipes.md`](layout-recipes.md) — coordinate system, hierarchical / left-to-right / grid layouts, frames, and the row-track flowchart / roadmap recipe.
