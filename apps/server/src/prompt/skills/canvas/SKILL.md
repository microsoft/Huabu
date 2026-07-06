---
name: canvas
description: Canvas mental model, tool boundaries, and command reference. The single entry point for any agent operating on a Huabu canvas.
appliesTo: [ask, operate, sketch, external]
version: 1
---

# Canvas

The canonical reference for working with a Huabu canvas. This file covers the **read** side: the on-disk layout and the tools that turn it into structured data. Mutation is gated behind a separate tool (`canvas_commands`) and a separate reference file — see the **Mutating a canvas** section below.

> **Schemas are the source of truth.** This skill explains _semantics_ and _idioms_. Field names, types, and required parameters live on the corresponding tool / command schema. When in doubt about a field, trust the schema.

---

## A canvas has two surfaces

A canvas exposes two complementary surfaces, each owned by its own family of tools. Pick the family by what you want to know, not by which tool feels familiar.

### Surface A — A folder of text files

Node text, frontmatter, skill files, memory, history. Read with `read`, `find`, `ls`, `grep`.

```
<canvas>/
  nodes/
    <safeLabel>.md         # one file per node: YAML frontmatter + Markdown body
  memory/*.md              # long-form, agent-curated memory
  skills/<id>/SKILL.md     # per-canvas skill overrides (optional)
  .artifacts/<id><ext>     # raw bytes (image / pdf / video / cover); `read` returns images inline, rejects pdf / video
  .history/                # saved threads, intent, event log (rarely needed)
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

### Surface B — Layout & connectivity data (`canvas.json`)

Where each node sits, how big it is, which frame it belongs to, what colour it's painted; every edge's endpoints and style. Stored as one `canvas.json` per canvas, served through `get_canvas_outline`, `inspect_nodes`, `inspect_edges`. These tools also expose **derived fields you can't read off disk** — `distance`, `direction`, `hops`, `clusterId`, `arrangement` — computed on the fly from the same data, which is why you should query through them rather than `read("canvas.json")` and parse it yourself.

### Boundary rule of thumb

| Property                                  | Tool                 |
| ----------------------------------------- | -------------------- |
| label, content, summary, keywords, src    | `read` / `grep`      |
| position, size, parentFrame, visual style | `inspect_nodes`      |
| edge direction / lineStyle / stroke       | `inspect_edges`      |
| whole-canvas overview, spatial clusters   | `get_canvas_outline` |

## Tool decision matrix

| Question                                       | Tool                                                     |
| ---------------------------------------------- | -------------------------------------------------------- |
| "Give me the lay of the land"                  | `get_canvas_outline()`                                   |
| "What does this node say?"                     | `read("nodes/<safeLabel>.md")`                           |
| "Where is this node? How big? In which frame?" | `inspect_nodes({ ids: ["<id>"] })`                       |
| "What's near this node?"                       | `inspect_nodes({ nearNode: { id } })`                    |
| "What connects to this node?"                  | `inspect_nodes({ connectedTo: { id } })`                 |
| "What does that edge look like?"               | `inspect_edges({ ids: ["<edgeId>"] })`                   |
| "Which nodes mention 'gradient descent'?"      | `grep`                                                   |
| "List all PDFs"                                | `find("**/*.pdf")` or `inspect_nodes({ byType: "pdf" })` |
| "Load a deeper canvas reference"               | `read("skills/canvas/references/<name>.md")`             |

> Per-tool argument shapes, defaults, and return envelopes live on each tool's schema description — trust those rather than restating them here. The notes below cover only behaviour the schema can't convey.

## Gotchas

- ** Selection & Position Geometry (CRITICAL):** The selected-node / anchor context **DOES NOT** directly contain position, size, parent frame, or geometry coordinates. If you need to place a new node near, relative to, or offset from a selected or anchor node, **you MUST first call `inspect_nodes({ ids: ["<anchorId>"] })`** (or `get_canvas_outline`) to query its absolute `(x, y)` position and size.
- **Nodes in context are metadata only.** Pass a node's supplied `file` path straight to `read` for the body. Only when a node is mentioned outside your context (e.g. it appears in a canvas snapshot but wasn't shown as a `<node>`) do you build the path yourself via the safeLabel rule above. For spatial / structural info (including position), call `inspect_nodes({ ids: ["<id>"] })`.
- **No cross-canvas access.** All paths are scoped to the active canvas.
- **`read` returns image artifacts inline** as vision content; pass the `src` from a node's frontmatter straight to `read`. PDF / video bytes still live under `.artifacts/` but are not readable — their `src` URL is the only handle.
- Before placing new nodes, anchor on the selection / a referenced node / a focal cluster — never pick coordinates from the global bbox alone, or new nodes land outside the user's viewport.

---

## Mutating a canvas

The filesystem tools (`read`, `find`, `ls`, `grep`) are read-only — there is no `write` / `edit_file` / `rm`. **Every mutation flows through one tool: `canvas_commands`.**

- If `canvas_commands` is **not** in your available tool list → you are in read-only mode. Do not attempt mutations and do not claim in your reply that you performed any.
- If `canvas_commands` **is** available → before issuing your first batch, `read("skills/canvas/references/commands.md")` for the catalogue, ID conventions, dependency-ordering rules, and style hints. The tool's own schema description tells you which fields each command takes; the reference tells you which command to pick and how to compose them.
- **Commands are not guaranteed to succeed.** Each command in a call reports its own outcome in `results[]`; on failure it carries a `reason` (e.g. `invalid-target` when a CONNECT / SET_NODE_PARENT endpoint doesn't exist). Read it and adjust — don't assume a write landed.
- **Don't invent node ids, and don't reference a node you're creating in the same call.** Create the nodes first; the result echoes each new node's real id in `results[].nodes`. Wire them up (`CONNECT_NODES` / `SET_NODE_PARENT`) in a follow-up call using those ids.

---

## Deeper dives

Load on demand when the situation calls for it:

- `read("skills/canvas/references/commands.md")` — **read this before any mutation.** The full `canvas_commands` catalogue, ID conventions, dependency ordering, style hints.
- `read("skills/canvas/references/command-cookbook.md")` — composed batch patterns: brainstorm, merge / synthesize, group into a frame, restyle a cluster, tidy a row, …
- `read("skills/canvas/references/layout-recipes.md")` — coordinate system, hierarchical / left-to-right / grid layouts, frames, and the row-track flowchart / roadmap recipe.
