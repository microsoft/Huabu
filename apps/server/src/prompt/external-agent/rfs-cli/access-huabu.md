# Accessing this Huabu Space

You are working with a **Huabu** Space, an infinite visual surface of notes, images, PDFs, sketches, questions, frames, and links. You do not see the Space directly. Use the optional `huabu-rfs` client through the host-supplied invocation (abbreviated below as `huabu-rfs`), and prefer direct `query`, `download`, `snapshot`, `upload`, and `execute` operations for deterministic reads and edits; they work without an internal model provider.

## Space model and discovery

Huabu separates bounded graph/geometry operations (`query`, `execute`) from out-of-band file bytes (`download`, `snapshot`, `upload`):

- **Coordinates:** x increases right and y increases downward. `position` is a node's top-left corner in **parent-local** coordinates (relative to its parent frame, or world coordinates at root); query results also include read-only `absolutePosition` in world coordinates.
- **Geometry before placement:** Selected-node context carries `id` and metadata, never coordinates or sizes. Query `INSPECT_NODES` before placing or resizing relative to existing nodes (use `position` for same-frame siblings, `absolutePosition` for root placement), and re-query after mutations when exact final geometry matters. `CREATE_NODES.position` is always required; never pin height on `text` or `question`.
- **Live operation contracts:** Load the exact current schema, limits, constraints, and examples only for the operation you are about to use, rather than guessing fields:

```bash
huabu-rfs query --help
huabu-rfs query --help INSPECT_NODES
huabu-rfs snapshot --help
huabu-rfs execute --help CREATE_NODES
```

Re-run `--help <TYPE>` whenever validation fails. CLI error messages point back to `huabu-rfs get-skill` when the Space guide can help.

## Read and upload files

### Query

Send one bounded query object (`huabu-rfs query` with `--json` or `--json-file`). Inspect responses report `count`, `total`, and `truncated`; search responses report `count` and `truncated`—narrow predicates or raise `limit` within the advertised maximum when truncated. Every response also returns `basis` (a Space read-version token for `execute --basis`):

- `INSPECT_NODES` — identity, type, parent, geometry, proximity, cluster, or connection filters (prefer anchor-scoped inspection when selected nodes already identify the area; Question Nodes with an existing conversation include `threadId`).
- `GET_SPACE_OUTLINE` — whole-Space orientation, bounding box, and clusters when no anchor is known.
- `INSPECT_EDGES` — edge endpoints and complete visual style.
- `SEARCH` — bounded literal search across labels, metadata, node bodies, and question threads.
- `SNAPSHOT_NODES` — underlying visual render query; in the CLI, prefer `huabu-rfs snapshot` below to render and save PNGs in one step.

```bash
huabu-rfs query --json '{"type":"INSPECT_NODES","ids":["node-123"]}'
```

### Snapshot

Render `image`, `sketch`, or recursive `frame` descendants into content-addressed PNGs and download all resulting files atomically into `<dir>` (`huabu-rfs snapshot --out-dir <dir> [--max-pixels <n>] [--padding <n>] [--stroke-subset <nodeId>:<s1,s2,...>] <nodeIds...>`). A single Frame or multi-node call may produce zero or more spatially clustered PNGs; stdout prints `{ "basis", "snapshots": [{ "src", "output", "width", "height", "originNodeIds" }] }` mapping each snapshot's bare `src` (`<artifactKey>`) to its saved local `output` path, dimensions, and contributing nodes. Run `huabu-rfs snapshot --help` for `strokeSubsets` details:

```bash
huabu-rfs snapshot --out-dir /tmp/snapshots --max-pixels 1280 sketch-123
```

### Download

Pass `<nodeId>` (from `<node id="...">`, `<note id="...">`, or `INSPECT_NODES`) or `<artifactKey>` (from `node.src`, snapshot `src`, or inline Note images) to `huabu-rfs download <id>`. Downloading a `<nodeId>` fetches that node's text/Markdown record and emits its `revision`, `basis`, and `node` metadata (including `node.src` for PDF/media nodes—pass `node.src` to a second `download` when you need the raw binary file). Always write to `--output <path>` so large bodies stay out of context; stdout streams NDJSON (`download_started`, optional `download_progress`, `download_completed`), and failed transfers exit nonzero while preserving any existing target file. Reuse `--if-revision <rev>` to emit `not_modified` without re-reading unchanged content:

```bash
huabu-rfs download --output /tmp/node.md node-123
huabu-rfs download --output /tmp/node.md --if-revision 3d7e node-123
huabu-rfs download --output /tmp/paper.pdf artifact-456.pdf
```

### Upload

Upload a local file into Space artifact storage (`huabu-rfs upload --file <path> [filename]`; pass `<filename>` explicitly when streaming `--file -` from stdin so the extension is preserved), returning `{ "id": "<artifactKey>", "size": ... }` (for example `artifact-8f2a.png`). Reference `<artifactKey>` directly in media `data.src` (for `web` nodes, `data.src` accepts an HTTPS URL, `data:` URI, or an existing `.html`/`.htm`/`.mhtml` `<artifactKey>`), PDF `coverUrl`, or inline Note Markdown `![](<artifactKey>)` / `![alt](<artifactKey>)`:

```bash
huabu-rfs upload --file ./diagram.png
```

## Mutate the Space safely

`huabu-rfs execute` accepts `{ "runId"?: string, "commands": [...] }` (plus optional CLI flags `--basis <token>` and `--operation-id <uuid>`). Run `huabu-rfs execute --help <COMMAND>` for one command's authoritative schema and example before constructing it. Confirm with the user before destructive, broad, or hard-to-reverse edits.

- `CREATE_NODES` — create nodes (`note`/`text`/`question` take authored body in `data.content` without YAML frontmatter; media nodes take `data.src`; `position` required).
- `INITIALIZE_PDF_NOTE` — create or reuse a PDF's linked hidden Note (`results[].nodes[0].nodeId`), then read/edit that Note by its own ID.
- `MERGE_NODE_DATA` — patch node fields (`patch.content` takes Markdown body only, stripped of downloaded `---` frontmatter, and requires `expectRev` from download `revision`; `properties` and `propertyDisplayKeys` need no `expectRev`—keep them in a separate patch entry from `content`).
- `DELETE_NODES` — delete nodes by ID (incident edges are removed automatically).
- `SET_NODE_GEOMETRY` — move or resize nodes in parent-local coordinates (`size.height: "auto"` fits a `note` to its text).
- `SET_NODE_PARENT` — move nodes into a Frame, or to root with `parentId: null`.
- `DISSOLVE_FRAME` — ungroup a Frame while keeping its children on the Space.
- `SET_FRAME_LAYOUT` — configure a Frame's `free`, `column`, `row`, or `grid` layout, track count, `cells`, `placements`, and `hug`/`manual` sizing.
- `ALIGN_NODES` — align nodes along `left`, `center`, `right`, `top`, `middle`, or `bottom`.
- `DISTRIBUTE_NODES` — spread apart three or more nodes within each parent group.
- `REORDER_NODES` — change z-order (`top`, `bottom`, `before`, or `after`).
- `CONNECT_NODES` — create directed or styled edges between existing nodes.
- `SET_EDGE_STYLE` — patch `lineType`, `lineStyle`, `stroke`, `strokeWidth`, `direction`, or `label` on existing edges.
- `DISCONNECT_EDGES` — remove edges by edge ID or `{ source, target }` pair.

Execution rules:

- **Inspect `results[]` on every call:** Commands run in order without rollback, and exit `0` only means transport completed—check `applied` and `reason` on each item (on `reason: "conflict"`, re-read and submit a fresh update).
- **Reference new IDs in a follow-up call:** Commands cannot reference server-assigned IDs created earlier in the same batch; read `results[].nodes` first, then connect or reparent, switching to the new `basis` returned by `execute`.
- **Pass `--basis` for structural safety:** Pass the latest `basis` (from `query`, node `download_started`, or `execute`) via `--basis <token>` so structural edits against deleted (`stale-target`) or reparented (`stale-parent`) nodes are rejected safely (on `409 basis-unknown`, query again for a fresh `basis`).
- **Replay with `--operation-id` or `result`:** `execute` attaches a UUID `operationId` (`runId` is correlation-only) and auto-retries dropped or `503 operation-outcome-unknown` calls. If it still fails and prints `operation-id=<uuid>` on stderr, replay the exact command with `--operation-id <uuid>` (and the same `--basis`) or check `huabu-rfs result <uuid>`—never resend without `--operation-id` unless you reconcile Space state first.
- **Link what you report:** When you tell the user about a node you created or updated, link it in your reply as `[label](#<node id>)`—`#` followed by the node's full ID, which already starts with `node-`, such as `[Research note](#node-1a2b3c)`—so they can jump to it with one click.

### Create a Note from Markdown

Write multi-line Markdown through `--json-file` so quotes and code fences are never mangled by shell quoting. Pass only the Markdown body in `data.content` (no `---` frontmatter; reference uploaded inline images as `![](<artifactKey>)`). Match nearby peer `size` from `INSPECT_NODES` when joining an existing layout, or use `{ "width": 400, "height": 300 }` as the default size for a new Note:

```bash
node -e '
const fs = require("fs");
fs.writeFileSync("/tmp/create-note.json", JSON.stringify({
  commands: [{
    type: "CREATE_NODES",
    nodes: [{
      nodeType: "note",
      data: { label: "Design Summary", content: fs.readFileSync("./summary.md", "utf8") },
      position: { x: 1200, y: 480 },
      size: { width: 400, height: 300 }
    }]
  }]
}));
'
huabu-rfs execute --json-file /tmp/create-note.json
```

For `parentId`, `style`, or `properties` fields run `huabu-rfs execute --help CREATE_NODES`; for multi-node grids, Frame layouts, and diagrams load `huabu-rfs get-skill layout`.

## Create and prompt Agents

Delegate work to a visible Agent Node on the Space or continue an existing Agent conversation (`huabu-rfs agent`):

- **Create an Agent Node:** Run `huabu-rfs agent profiles` and pick a selectable `profileId` (never guess `profileId`; omitting `profileId` uses the first selectable external Profile marked `default: true`). Pass `--json` or `--json-file` with `profileId`, `prompt`, and `position` (plus optional `workingDirPath`, or `--no-start` without `prompt` to create idle). The SSE stream begins with a `created` event carrying `nodeId` and `threadId`.
- **Talk to an Agent Node:** Take `threadId` from `created` or from `INSPECT_NODES` on an existing Question Node, then send actual prompt text via `huabu-rfs agent prompt --text-file ./follow-up.txt <threadId>` (add `--until-accepted` for asynchronous handoff once durably accepted). Never send a local file path as the prompt text itself, and never blindly resend after a timeout or unconfirmed acceptance.

```bash
huabu-rfs agent profiles
huabu-rfs agent create --json '{"profileId":"profile-id","prompt":"Summarize the selected notes.","position":{"x":1200,"y":480}}'
huabu-rfs agent prompt --until-accepted --text-file ./follow-up.txt thread-123
```

For full `create` JSON options (`additionalInitialPreamble`, `--no-start`), SSE framing, and `--until-accepted` recovery rules, run `huabu-rfs get-skill agents` (or `huabu-rfs agent --help`).

## Focused workflows

Load a focused guide only when the task requires it (`huabu-rfs get-skill <id>`):

- `layout` — canonical per-type default sizes, Note sizing rules, free-Frame insets, structured `column`/`row`/`grid` Frames, and diagram recipes (`huabu-rfs get-skill layout`).
- `agents` — full Agent creation/continuation reference, Profile selection, SSE stream events, and `--until-accepted` handoff semantics (`huabu-rfs get-skill agents`).
- `services` — configured provider Service discovery, safe Package extraction (`<id>/service.yaml` + declared files), reading `SKILL.md` before use, and in-memory configuration leases (`huabu-rfs get-skill services` or `huabu-rfs service --help`). Never print, persist, or pass leased credentials via argv or shell env.
