---
id: canvas
name: canvas
description: Canvas mental model, tool boundaries, and command reference. The single entry point for any agent operating on a Huabu canvas.
appliesTo: [ask, operate, annotation, external]
version: 1
---

# Canvas

The canonical reference for working with a Huabu canvas. This file covers the **read** side: the on-disk layout and the tools that turn it into structured data. Mutation is gated behind a separate tool (`canvas_commands`) and a separate reference file — see [Mutating a canvas](#mutating-a-canvas) below.

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
  .artifacts/<id><ext>     # raw bytes for image / pdf / video / cover (binary — `read` rejects these)
  .history/                # saved threads, intent, event log (rarely needed)
```

A node's filename is deterministically derived from its `label` and kept in 1:1 sync, so when you have the label you can build the path yourself:

```
nodes/<safeLabel>.md
```

`safeLabel` = the label with characters `\ / : * ? " < > |` (and ASCII control chars) replaced by `_`, then leading/trailing dots and spaces trimmed, then truncated to 120 chars. Empty / missing labels fall back to the stable `nodeId`.

- Have the label → `read("nodes/<safeLabel>.md")` directly. **Don't** `find` first when you already have the label — build the path.
- Have only the nodeId → `find("nodes/*.md")` or `grep` (results carry `nodeId`, `label`, `nodeType`); the stable id also lives in each file's `id:` frontmatter.
- A direct read returns ENOENT (rare — usually means the label was just edited mid-flight) → fall back to `find` / `grep`.

### Surface B — Layout & connectivity data (`canvas.json`)

Where each node sits, how big it is, which frame it belongs to, what colour it's painted; every edge's endpoints and style. Stored as one `canvas.json` per canvas, served through `get_canvas_outline`, `inspect_nodes`, `inspect_edges`. These tools also expose **derived fields you can't read off disk** — `distance`, `direction`, `hops`, `clusterId`, `arrangement` — computed on the fly from the same data, which is why you should query through them rather than `read("canvas.json")` and parse it yourself.

### Boundary rule of thumb

| Property                                | Tool                 |
| --------------------------------------- | -------------------- |
| label, content, summary, keywords, src  | `read` / `grep`      |
| position, size, parentId, visual style  | `inspect_nodes`      |
| edge direction / lineStyle / stroke     | `inspect_edges`      |
| whole-canvas overview, spatial clusters | `get_canvas_outline` |

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

- **Selected-node context is sparse.** The agent only receives `id + label + type` for selected nodes — no content, no summary, no geometry. Build the markdown path from the label (see § "Surface A — A folder of text files") and `read` it; use `inspect_nodes({ ids: ["<id>"] })` for spatial / structural info.
- **No cross-canvas access.** All paths are scoped to the active canvas.
- **Binary files are rejected by `read`.** Image / PDF / video bytes live under `.artifacts/`; the `src` URL is in the node markdown frontmatter.

---

## Mutating a canvas

The filesystem tools (`read`, `find`, `ls`, `grep`) are read-only — there is no `write` / `edit_file` / `rm`. **Every mutation flows through one tool: `canvas_commands`.**

- If `canvas_commands` is **not** in your available tool list → you are in read-only mode. Do not attempt mutations and do not claim in your reply that you performed any.
- If `canvas_commands` **is** available → before issuing your first batch, `read("skills/canvas/references/commands.md")` for the catalogue, ID conventions, batch-ordering rules, and style hints. The tool's own schema description tells you which fields each command takes; the reference tells you which command to pick and how to compose them.

---

## Deeper dives

Load on demand when the situation calls for it:

- `read("skills/canvas/references/commands.md")` — **read this before any mutation.** The full `canvas_commands` catalogue, ID conventions, batch ordering, style hints.
- `read("skills/canvas/references/command-cookbook.md")` — composed batch patterns: brainstorm, merge / synthesize, group into a frame, restyle a cluster, tidy a row, …
- `read("skills/canvas/references/layout-recipes.md")` — coordinate system, hierarchical / left-to-right / grid layouts, frames, and the row-track flowchart / roadmap recipe.
