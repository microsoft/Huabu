# Accessing this Huabu Space

You are working with a **Huabu** Space, an infinite visual surface of notes, images, PDFs, sketches, questions, frames, and links. You do not see the Space directly. Use plain HTTP (`curl`, `wget`, `Invoke-RestMethod`, Python, or Node `fetch`) with the pre-injected environment, and prefer direct `query`, `download`, `upload`, and `execute` operations for deterministic reads and edits; they work without an internal model provider:

- `HUABU_RFS_URL` — Space base URL, with no trailing slash.
- `HUABU_RFS_TOKEN` — bearer credential (`AUTH="Authorization: Bearer $HUABU_RFS_TOKEN"`).
- `HUABU_THREAD_ID` — conversation ID; pass `X-Huabu-Host-Thread-Id: $HUABU_THREAD_ID` on `POST execute` and `POST agent` to attribute edits.

## Space model and discovery

Huabu separates bounded graph/geometry operations (`query`, `execute`) from out-of-band file bytes (`download`, `upload`):

- **Coordinates:** x increases right and y increases downward. `position` is a node's top-left corner in **parent-local** coordinates (relative to its parent frame, or world coordinates at root); query results also include read-only `absolutePosition` in world coordinates.
- **Geometry before placement:** Selected-node context carries `id` and metadata, never coordinates or sizes. Query `INSPECT_NODES` before placing or resizing relative to existing nodes (use `position` for same-frame siblings, `absolutePosition` for root placement), and re-query after mutations when exact final geometry matters. `CREATE_NODES.position` is always required; never pin height on `text` or `question`.
- **Live operation contracts:** Fetch `/capabilities` once for protocol limits, permissions, execution semantics, and supported types, then load the schema only for the operation you are about to use rather than guessing fields:

```bash
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/capabilities"
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/capabilities/queries/INSPECT_NODES"
COMMAND=CREATE_NODES
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/capabilities/commands/$COMMAND"
```

Re-fetch the relevant capability when validation fails. Validation and transport errors return `{ "message": ..., "code"?: ... }` and include a `/skill` recovery command.

## Read and upload files

### Query

Send one bounded query object to `POST query`. Inspect responses report `count`, `total`, and `truncated`; search responses report `count` and `truncated`—narrow predicates or raise `limit` within the advertised maximum when truncated. Every response also returns `basis` (a Space read-version token for `POST execute`):

- `INSPECT_NODES` — identity, type, parent, geometry, proximity, cluster, or connection filters (prefer anchor-scoped inspection when selected nodes already identify the area; Question Nodes with an existing conversation include `threadId`).
- `GET_SPACE_OUTLINE` — whole-Space orientation, bounding box, and clusters when no anchor is known.
- `INSPECT_EDGES` — edge endpoints and complete visual style.
- `SEARCH` — bounded literal search across labels, metadata, node bodies, and question threads.
- `SNAPSHOT_NODES` — visual render query for `image`, `sketch`, and `frame` nodes (see `Snapshot` below).

```bash
curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  --data-binary '{"type":"INSPECT_NODES","ids":["node-123"]}' \
  "$HUABU_RFS_URL/query"
```

### Snapshot

Render `image`, `sketch`, or recursive `frame` descendants into content-addressed PNGs via `POST query` (`GET capabilities/queries/SNAPSHOT_NODES` for `maxPixels`, `padding`, and `strokeSubsets`), returning `{ "type": "SNAPSHOT_NODES", "basis": "...", "result": { "snapshots": [{ "src", "width", "height", "originNodeIds" }] } }`, then fetch each bare `src` (`<artifactKey>`) via `GET /download/<id>`. A single Frame or multi-node request may return zero or more spatially clustered PNGs, with `originNodeIds` listing every contributing node:

```bash
curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  --data-binary '{"type":"SNAPSHOT_NODES","nodeIds":["sketch-123"],"maxPixels":1280}' \
  "$HUABU_RFS_URL/query"
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/download/sketch-raster-abc123.png" -o /tmp/snap.png
```

### Download

Pass a URL-encoded `<nodeId>` (from `<node id="...">`, `<note id="...">`, or `INSPECT_NODES`) or `<artifactKey>` (from `X-Huabu-Src`, snapshot `src`, or inline Note images) to `GET /download/<id>`. Downloading a `<nodeId>` fetches that node's text/Markdown record plus `X-Huabu-Node-*`, `X-Huabu-Src`, `X-Huabu-Basis`, and `ETag` headers (pass `X-Huabu-Src` to a second `download` when you need a PDF/media node's raw binary file). Always write bodies to a file rather than stdout, and send `If-None-Match` (using `ETag`, `INSPECT_NODES.rev`, or a Space Skill Note's `rev`) staged to a temporary file so `304 Not Modified` never overwrites a cached file:

```bash
STATUS="$(curl -sS -H "$AUTH" -H 'If-None-Match: "3d7e"' \
  -D /tmp/huabu-headers.txt -o /tmp/node.next -w '%{http_code}' \
  "$HUABU_RFS_URL/download/node-123")"
[ "$STATUS" = 200 ] && mv /tmp/node.next /tmp/node.md
[ "$STATUS" = 304 ] && rm -f /tmp/node.next
```

Treat any status other than `200` or `304` as an error and discard `/tmp/node.next`.

### Upload

Upload file bytes into Space artifact storage (`POST /upload/<filename>`), returning `{ "id": "<artifactKey>", "size": ... }` (for example `artifact-8f2a.png`, preserving `<filename>`'s extension). Reference `<artifactKey>` directly in media `data.src` (for `web` nodes, `data.src` accepts an HTTPS URL, `data:` URI, or an existing `.html`/`.htm`/`.mhtml` `<artifactKey>`), PDF `coverUrl`, inline Note Markdown `![](<artifactKey>)` / `![alt](<artifactKey>)`, or Interactive View `rendererArtifact`:

```bash
curl -fsS -H "$AUTH" --data-binary @./diagram.png "$HUABU_RFS_URL/upload/diagram.png"
```

## Mutate the Space safely

`POST execute` accepts `{ "runId"?: string, "operationId"?: string, "basis"?: string, "commands": [...] }`. Fetch `/capabilities/commands/$COMMAND` for one command's authoritative `schema`, `constraints`, `result`, and `examples` before constructing it, and include `X-Huabu-Host-Thread-Id: $HUABU_THREAD_ID` for edit attribution. Confirm with the user before destructive, broad, or hard-to-reverse edits.

```bash
curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  -H "X-Huabu-Host-Thread-Id: $HUABU_THREAD_ID" \
  --data-binary @/tmp/huabu-execute.json "$HUABU_RFS_URL/execute"
```

- `CREATE_NODES` — create nodes (`note`/`text`/`question` take authored body in `data.content` without YAML frontmatter; media nodes take `data.src`; `position` required).
- `INITIALIZE_PDF_NOTE` — create or reuse a PDF's linked hidden Note (`results[].nodes[0].nodeId`), then read/edit that Note by its own ID.
- `MERGE_NODE_DATA` — patch node fields (`patch.content` takes Markdown body only, stripped of downloaded `---` frontmatter, and requires unquoted `ETag` in `expectRev`; `properties` and `propertyDisplayKeys` need no `expectRev`—keep them in a separate patch entry from `content`).
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

- **Inspect `results[]` on every call:** Commands run in order without rollback, and HTTP `200` does not mean every command applied—check `applied` and `reason` on each item (on `reason: "conflict"`, re-read and submit a fresh update).
- **Reference new IDs in a follow-up call:** Commands cannot reference server-assigned IDs created earlier in the same batch; read `results[].nodes` first, then connect or reparent, switching to the new `basis` returned by `POST execute`.
- **Pass `basis` for structural safety:** Send the latest `basis` (from `POST query`, node `X-Huabu-Basis`, or `POST execute`) in the execute body so structural edits against deleted (`stale-target`) or reparented (`stale-parent`) nodes are rejected safely (on `409 basis-unknown`, query again for a fresh `basis`).
- **Use `operationId` for idempotent retry:** Generate a UUID `operationId` (`runId` is correlation-only) and send the identical file-backed body on timeout, dropped connection, or `503 operation-outcome-unknown` (or read `GET execute/<operationId>` without re-executing)—never retry without `operationId` unless you reconcile Space state first.

### Create a Note from Markdown

Serialize multi-line Markdown into a JSON file rather than inline shell strings so quotes and code fences stay intact. Pass only the Markdown body in `data.content` (no `---` frontmatter; reference uploaded inline images as `![](<artifactKey>)`). Match nearby peer `size` from `INSPECT_NODES` when joining an existing layout, or use `{ "width": 400, "height": 300 }` as the default size for a new Note:

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
curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  -H "X-Huabu-Host-Thread-Id: $HUABU_THREAD_ID" \
  --data-binary @/tmp/create-note.json "$HUABU_RFS_URL/execute"
```

For `parentId`, `style`, or `properties` fields fetch `GET capabilities/commands/CREATE_NODES`; for multi-node grids, Frame layouts, and diagrams load `GET skill/layout`.

## Create and prompt Agents

Delegate work to a visible Agent Node on the Space or continue an existing Agent conversation:

- **Create an Agent Node:** Fetch `GET /agent/profiles` and pick a selectable `profileId` (never guess `profileId`; `text/plain` without `profileId` requires a `default: true` Profile). Send `POST /agent` as `application/json` with `profileId`, `prompt`, and `position` (plus optional `workingDirPath`, or `X-Huabu-Agent-Start: false` without `prompt` to create idle). The SSE stream begins with a `created` event carrying `nodeId` and `threadId`.
- **Talk to an Agent Node:** Take `threadId` from `created` or from `INSPECT_NODES` on an existing Question Node, then `POST /agent/<threadId>/prompt` with actual prompt bytes (set `X-Huabu-Event-Mode: all` and read until `event: accepted` for asynchronous handoff). Never send a local file path as the prompt text itself, and never blindly resend after a timeout or unconfirmed acceptance.

```bash
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/agent/profiles"
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -H "X-Huabu-Host-Thread-Id: $HUABU_THREAD_ID" \
  --data-binary '{"profileId":"profile-id","prompt":"Summarize the selected notes.","position":{"x":1200,"y":480}}' \
  "$HUABU_RFS_URL/agent"
curl -N -H "$AUTH" -H "Content-Type: text/plain" --data-binary @./follow-up.txt "$HUABU_RFS_URL/agent/thread-123/prompt"
```

For full `POST /agent` JSON options (`additionalInitialPreamble`, `X-Huabu-Agent-Start`), SSE framing, and `event: accepted` handoff rules, load `GET skill/agents`.

## Focused workflows

Load an authenticated focused guide only when the task requires it (`curl -fsS -H "$AUTH" "$HUABU_RFS_URL/skill/<id>"`):

- `GET skill/layout` — canonical per-type default sizes, Note sizing rules, free-Frame insets, structured `column`/`row`/`grid` Frames, and diagram recipes.
- `GET skill/agents` — full Agent creation/continuation reference, Profile selection, SSE stream events, and `event: accepted` asynchronous handoff semantics.
- `GET skill/services` — configured provider Service discovery (`/services`), Package archive download (`<id>/service.yaml` + declared files), reading `SKILL.md` before use, and in-memory `POST /services/<id>/lease`. Never print, persist, or pass leased credentials via argv or shell env.
- `GET skill/tasks` — durable long-horizon Tasks and Runs.
- `GET skill/interactive-views` — durable sandboxed HTML Views with Host-owned state, bindings, navigation, and Agent actions.
