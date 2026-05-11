---
id: canvas
name: canvas
description: Canvas mental model, tool boundaries, and command reference. The single entry point for any agent operating on a Sediment canvas.
appliesTo: [ask, operate, annotation, external]
version: 1
---

# Canvas

This is the canonical reference for working with a Sediment canvas. It covers the filesystem layout, how to choose between query tools, and the full command catalogue. Deeper material lives in `references/` and is loaded only when needed.

> **Mode awareness.** This skill is loaded by both ask and operate agents. If `canvas_commands` is **not** in your available tool list, you are in read-only (ask) mode — use `read` / `inspect_nodes` / `inspect_edges` / `grep` / `find` / `ls` to answer the user's question, and treat the "Command catalogue" section below as background context only. Do **not** attempt mutations and do **not** claim in your reply that you performed any.

> **Schemas are the source of truth.** This skill explains _semantics_ and _idioms_. Field names, types, and required parameters live on the corresponding tool / command schema. When in doubt about a field, trust the schema.

## Mental model: where data lives

Each canvas is a folder on disk. The two files that matter most:

- `canvas.json` — geometry, parents, edges. The **layout** of the canvas.
- `nodes/<nodeId>.md` — per-node markdown with YAML frontmatter (`label`, `type`, `src?`, `summary?`, `keywords?`) plus a Markdown body.

Other paths the agent may encounter: `.history/chat/<threadId>.json` (saved threads), `.history/intent.json` / `.history/events.jsonl` (intent + event logs), `memory/*.md` (long-form memory), `artifacts/*` (binary blobs — only their metadata is readable here), `skills/<id>/SKILL.md` (per-canvas skill overrides).

Boundary rule of thumb:

- _Anything textual about a node_ (label, content, summary, keywords, type, src) → `read("nodes/<nodeId>.md")`.
- _Anything spatial / structural about a node_ (position, size, parentId, style) → `inspect_nodes({ ids: [...] })`.
- _Anything about an edge's appearance or direction_ → `inspect_edges`. The outline only carries topology.

## Tool decision matrix

| Question                                       | Tool                                                     |
| ---------------------------------------------- | -------------------------------------------------------- |
| "Give me the lay of the land"                  | `get_canvas_outline()`                                   |
| "What does this node say?"                     | `read("nodes/<id>.md")`                                  |
| "Where is this node? How big? In which frame?" | `inspect_nodes({ ids: ["<id>"] })`                       |
| "What's near this node?"                       | `inspect_nodes({ nearNode: { id } })`                    |
| "What connects to this node?"                  | `inspect_nodes({ connectedTo: { id } })`                 |
| "What does that edge look like?"               | `inspect_edges({ ids: ["<edgeId>"] })`                   |
| "Which nodes mention 'gradient descent'?"      | `grep`                                                   |
| "List all PDFs"                                | `find("**/*.pdf")` or `inspect_nodes({ byType: "pdf" })` |
| "Load a deeper canvas reference"               | `read("skills/canvas/references/<name>.md")`             |

### Tool quick reference

- **`get_canvas_outline()`** — one-shot map of the entire canvas: every node's `{id, type, label, parentId, position, width, height}`, topology-only edges, and pre-computed spatial clusters. Call it **once** when entering a canvas. Opt-in flags: `includePreviews:true` (short text preview per node), `includeStyle:true` (visual style per node — only set for visual / styling tasks).
- **`read(path)`** — single-file fetch. Returns JSON with raw `content` plus parsed `frontmatter` when the file starts with a YAML fence. Use for one specific node, one skill file, or any other named file. Do **not** use it to multi-fetch (use `find` then `read` each match) or to search content (use `grep`).
- **`grep(pattern, path?)`** — regex (or `literal:true`) content search. Defaults to the whole canvas folder. Matches inside `nodes/<id>.md` also surface `nodeId`, `label`, `nodeType` so you can chain without a second lookup. Skips `.history/`, `.git/`, `node_modules/`.
- **`find(glob, path?)` / `ls(path?)`** — filename / directory enumeration. Use `find` for glob patterns (`nodes/*.md`); use `ls` to peek at a directory.
- **`inspect_nodes(predicates)`** — predicate node lookup. Predicates AND together; **always supply at least one**. Common shapes: `{ ids }`, `{ nearNode: { id, maxDistance?, sameParent? } }`, `{ connectedTo: { id, depth?: 1|2 } }`, `{ inRect }`, `{ inSameClusterAs }`, `{ byType }`, `{ byParent }`, `{ labelPattern }`. Returns full geometry + style. Honours `limit` (default 50); `truncated:true` means refine or raise the limit.
- **`inspect_edges(predicates)`** — edge lookup when you need `direction`, `lineStyle`, `lineType`, `stroke`, `strokeWidth`. Common shapes: `{ ids }`, `{ connectedTo }`, `{ between: { a, b } }`, `{ byDirection }`, `{ byLineStyle }`. Defaults applied on read: `direction='none'`, `lineStyle='solid'`, `lineType='bezier'`.

### Gotchas

- **Selected-node context is sparse.** The agent only receives `id + label + type` for selected nodes — no content, no summary, no geometry. Reach for `read` / `inspect_nodes` when you need more.
- **No cross-canvas access.** All paths are scoped to the active canvas.
- **Binary files are rejected by `read`.** Image / PDF / video bytes live under `artifacts/`; the `src` URL is in the node markdown frontmatter.

## Command catalogue _(requires `canvas_commands`)_

`canvas_commands` takes one batch of `CanvasCommand` objects and applies them as a **single atomic undo step**. One batch per user intent — fewer batches means fewer re-renders and a cleaner undo history.

Structural mutations (nodes & edges):

- **CREATE_NODES** — create one or more nodes. Set `skipAutoLayout: true` whenever you supply an explicit `position` so the force-directed engine does not override it.
- **CREATE_QUESTION** — create a question node the user is expected to answer. Use this to surface follow-ups instead of asking in chat.
- **DELETE_NODES** — remove nodes by id. Incident edges are removed automatically.
- **MERGE_NODE_DATA** — shallow-merge a patch into `node.data` (label / content / style). Style supports `accent` (palette token, top stripe + edge stroke) and `backgroundColor` on every node type; text-only style fields apply only to text nodes.
- **CONNECT_NODES** — create edges. Style fields (lineType, lineStyle, stroke, strokeWidth, direction) are optional and pulled from the edge schema.
- **DISCONNECT_EDGES** — remove edges by id or by source/target pair.
- **SET_EDGE_STYLE** — patch visual style on existing edges.

Container / hierarchy:

- **SET_NODE_PARENT** — move nodes into a frame, or out of a frame (`parentId: null`).
- **DISSOLVE_FRAME** — ungroup a frame, keep child nodes at root.

Layout:

- **SET_NODE_GEOMETRY** — set position and/or size on existing nodes.
- **REORDER_NODES** — change z-order (`top` / `bottom` / `{before|after: id}`).
- **ALIGN_NODES** — align selected nodes along an axis.
- **DISTRIBUTE_NODES** — even spacing across ≥3 nodes.
- **AUTO_LAYOUT** — run force-directed layout on the whole canvas or one frame.

### ID conventions

- Node IDs: `node-<uuid>` (use `crypto.randomUUID()`).
- Edge IDs: `edge-<uuid>`.
- When a later command in the same batch references a node created by an earlier command, **provide an explicit `id` on the CREATE_NODES entry** so the reference resolves.

### Batch ordering

`canvas_commands` runs serially within a single call (declared order is preserved). When the LLM emits two `canvas_commands` calls in the same agent batch, pi-agent-core also serialises them — so a later call always sees the effects of the earlier one. Take advantage of this:

1. Create everything you need to reference (with explicit ids).
2. Wire it up (`CONNECT_NODES`, `SET_NODE_PARENT`).
3. Polish (`ALIGN_NODES`, `DISTRIBUTE_NODES`, `AUTO_LAYOUT`).

## Style hints

- Always set a concise `data.label` on every node — it is what the user sees when zoomed out.
- For `note` nodes, `data.content` is Markdown — write substantive, well-formatted bodies.
- For `frame` nodes, set `data.label`; size the frame to enclose its children with ~40px padding.
- Use the same `style.accent` for nodes that belong to the same logical group; reserve `grey` for de-emphasised material.

## Deeper dives

Load on demand when the situation calls for it:

- `read("skills/canvas/references/command-cookbook.md")` — composed batch patterns: brainstorm, merge / synthesize, group into a frame, restyle a cluster, tidy a row, …
- `read("skills/canvas/references/layout-recipes.md")` — coordinate system, hierarchical / left-to-right / grid layouts, frames, accent palettes, and the row-track flowchart / roadmap recipe.
