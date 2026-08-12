---
name: space
description: Space mental model (the infinite work surface), tool boundaries, and command reference. The single entry point for any agent operating on a Huabu Space.
appliesTo: [ask, operate, external]
version: 1
---

# Space

The canonical reference for working with a Huabu Space. This file covers the **read** side: the on-disk layout and the tools that turn it into structured data. Mutation is gated behind a separate tool (`space_commands`) and a separate reference file — see the **Mutating a Space** section below.

> **Schemas are the source of truth.** This skill explains _semantics_ and _idioms_. Field names, types, and required parameters live on the corresponding tool / command schema. When in doubt about a field, trust the schema.

---

## A Space has two surfaces

A Space exposes two complementary surfaces, each owned by its own family of tools. Pick the family by what you want to know, not by which tool feels familiar.

### Surface A — A folder of text files

Node text, frontmatter, skill files, memory, history. Read with `read`, `find`, `ls`, `grep`.

```
<Space>/
  nodes/
    <safeLabel>.md         # one file per node: YAML frontmatter + Markdown body
  memory/*.md              # long-form, agent-curated memory
  skills/<id>/SKILL.md     # per-Space skill overrides (optional)
  .artifacts/<id><ext>     # raw bytes (image / pdf / video / cover); `read` returns images inline, rejects pdf / video
  .history/                # saved threads, event log (rarely needed)
```

A node's filename is deterministically derived from its `label` and kept in 1:1 sync, so when you have the label you can build the path yourself:

```
nodes/<safeLabel>.md
```

`safeLabel` = the label with characters `\ / : * ? " < > |` (and ASCII control chars) replaced by `_`. **Spaces, hyphens, parentheses, dots, and any other character are kept verbatim** — do not substitute them. Only leading/trailing dots and spaces are stripped, and the result is truncated to 120 chars. Empty / missing labels fall back to the stable `nodeId`.

Examples:

| label               | safeLabel           | path                         |
| ------------------- | ------------------- | ---------------------------- |
| `Dolphin Migration` | `Dolphin Migration` | `nodes/Dolphin Migration.md` |
| `Notes (draft)`     | `Notes (draft)`     | `nodes/Notes (draft).md`     |
| `Foo: Bar / Baz`    | `Foo_ Bar _ Baz`    | `nodes/Foo_ Bar _ Baz.md`    |
| `   trailing.`      | `trailing`          | `nodes/trailing.md`          |

- Have the label → `read("nodes/<safeLabel>.md")` directly. **Don't** `find` first when you already have the label — build the path.
- Have only the nodeId → `find("nodes/*.md")` or `grep` (results carry `nodeId`, `label`, `nodeType`); the stable id also lives in each file's `id:` frontmatter.
- A direct read returns ENOENT (rare — usually means the label was just edited mid-flight) → fall back to `find` / `grep`.

### Surface B — Layout & connectivity data (`space.json`)

Where each node sits, how big it is, which frame it belongs to, what colour it's painted; every edge's endpoints and style. Stored as one `space.json` per Space, served through `get_space_outline`, `inspect_nodes`, `inspect_edges`. These tools also expose **derived fields you can't read off disk** — `distance`, `direction`, `hops`, `clusterId`, `arrangement` — computed on the fly from the same data, which is why you should query through them rather than `read("space.json")` and parse it yourself.

### Boundary rule of thumb

| Property                                  | Tool                |
| ----------------------------------------- | ------------------- |
| label, content, summary, keywords, src    | `read` / `grep`     |
| position, size, parentFrame, visual style | `inspect_nodes`     |
| edge direction / lineStyle / stroke       | `inspect_edges`     |
| whole-Space overview, spatial clusters    | `get_space_outline` |

## Tool decision matrix

| Question                                       | Tool                                                     |
| ---------------------------------------------- | -------------------------------------------------------- |
| "Give me the lay of the land"                  | `get_space_outline()`                                    |
| "What does this node say?"                     | `read("nodes/<safeLabel>.md")`                           |
| "Where is this node? How big? In which frame?" | `inspect_nodes({ ids: ["<id>"] })`                       |
| "What's near this node?"                       | `inspect_nodes({ nearNode: { id } })`                    |
| "What connects to this node?"                  | `inspect_nodes({ connectedTo: { id } })`                 |
| "What does that edge look like?"               | `inspect_edges({ ids: ["<edgeId>"] })`                   |
| "Which nodes mention 'gradient descent'?"      | `grep`                                                   |
| "List all PDFs"                                | `find("**/*.pdf")` or `inspect_nodes({ byType: "pdf" })` |
| "Load a deeper Space reference"                | `read("skills/space/references/<name>.md")`              |

## Gotchas

Behaviour the schema can't convey:

- ** Selection & Position Geometry (CRITICAL):** The selected-node / anchor context **DOES NOT** directly contain position, size, parent frame, or geometry coordinates. If you need to place a new node near, relative to, or offset from a selected or anchor node, **you MUST first call `inspect_nodes({ ids: ["<anchorId>"] })`** (or `get_space_outline`) to query its geometry.
- **Coordinates — idioms.** Each node carries two coordinate fields (defined on the `inspect_nodes` / `space_commands` schemas): writable **parent-local** `position` and read-only **world** `absolutePosition`. Practical placement: to put a child next to a sibling in the same frame, add an offset to the sibling's `position`; to place a root node near some reference, use the reference's `absolutePosition` (root-local == world); to align a framed child to something outside its frame, submit `target.absolutePosition − thisFrame.absolutePosition`. Into a `column`/`row`/`grid` (structured) frame, `position` is only a sort hint — the frame owns the final slot. In `grid` mode `position` does **not** decide rows either: pass `cells` on `SET_FRAME_LAYOUT` to place children, giving paired children the same `row`.
- **Nodes in context are metadata only.** Pass a node's supplied `file` path straight to `read` for the body. Only when a node is mentioned outside your context (e.g. it appears in a Space snapshot but wasn't shown as a `<node>`) do you build the path yourself via the safeLabel rule above. For spatial / structural info (including position), call `inspect_nodes({ ids: ["<id>"] })`.
- **Cross-Space reads are World-only.** Tools default to the conversation's Space. In a World conversation, first read the World outline, take `targetCanvasId` from a canonical `canvasRef`, then pass it to `get_space_outline`, `inspect_nodes`, `inspect_edges`, `read`, `grep`, `find`, or `ls`. The server rejects arbitrary Canvas IDs. `snapshot_nodes` remains owner-scoped because it materializes cache artifacts; use `read` with `targetCanvasId` to view source images inline. This never grants cross-Space writes; `space_commands` remains World-scoped.
- **`read` returns image artifacts inline** as vision content: pass an image node's frontmatter `src` straight to `read`, OR — for an inline `![](<key>)` image embedded in a note body — call `read(".artifacts/<key>")` to see it. PDF / video bytes still live under `.artifacts/` but are not readable — their `src` URL is the only handle.
- Before placing new nodes, anchor on the selection / a referenced node / a focal cluster — never pick coordinates from the global bbox alone, or new nodes land outside the user's viewport. If setting `size`, inspect and match comparable nearby nodes; with no comparable peer, omit it and use the canonical default. See `layout-recipes.md` for long-Note and per-type sizing rules.

---

## Mutating a Space

The filesystem tools (`read`, `find`, `ls`, `grep`) are read-only — there is no `write` / `edit_file` / `rm`. **Every mutation flows through one tool: `space_commands`.**

- If `space_commands` is **not** in your available tool list → you are in read-only mode. Do not attempt mutations and do not claim in your reply that you performed any.
- If `space_commands` **is** available → the tool's own schema and description carry the full command set, the id / dependency-ordering rule, and per-field behaviour. For composed multi-command recipes see `command-cookbook.md`; for diagram geometry see `layout-recipes.md`.
- **Commands are not guaranteed to succeed.** Each command in a call reports its own outcome in `results[]`; on failure it carries a `reason` (e.g. `invalid-target` when a CONNECT / SET_NODE_PARENT endpoint doesn't exist). Read it and adjust — don't assume a write landed.

---

## Deeper dives

Load on demand when the situation calls for it:

- `read("skills/space/references/command-cookbook.md")` — composed batch patterns: brainstorm, merge / synthesize, group into a frame, restyle a cluster, tidy a row, …
- `read("skills/space/references/layout-recipes.md")` — coordinate system, hierarchical / left-to-right / grid layouts, frames (including when to pick the row-aligned `grid` frame mode over `column`), and the row-track flowchart / roadmap recipe.
