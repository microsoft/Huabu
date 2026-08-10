# Accessing this Huabu Space

You are working with a **Huabu** Space, an infinite visual surface of notes, images, PDFs, sketches, questions, frames, and links. You do not see the Space directly. Use plain HTTP with `curl`, `wget`, `Invoke-RestMethod`, Python `requests`, or Node `fetch`; no custom tool or SDK is required.

These environment variables are already set:

- `HUABU_RFS_URL` — the base URL for this Space, with no trailing slash.
- `AGENTLET_TOKEN` — the RFS bearer credential.
- `HUABU_THREAD_ID` — your conversation ID. Pass it on `execute` (see §6) to attribute your edits.

Prefer deterministic direct operations:

1. Discover supported queries and commands through `capabilities`.
2. Use `query` for graph, geometry, and content search.
3. Use `download` for full node or artifact bytes.
4. Use the `SNAPSHOT_NODES` query to render image, sketch, or frame nodes into PNG artifacts you can inspect.
5. Use `execute` for validated Space commands.
6. Use `agent` only when you deliberately want the optional internal Huabu agent to interpret an open-ended request.

## 1. Discover operations

Fetch the compact handshake once:

```bash
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/capabilities"
```

It reports protocol version, effective read/write permissions, limits, execution semantics, supported query and command types, and links. Load a detailed schema only for the operation you are about to use:

```bash
curl -fsS -H "$AUTH" \
  "$HUABU_RFS_URL/capabilities/queries/INSPECT_NODES"

curl -fsS -H "$AUTH" \
  "$HUABU_RFS_URL/capabilities/commands/CREATE_NODES"

curl -fsS -H "$AUTH" \
  "$HUABU_RFS_URL/capabilities/queries/SNAPSHOT_NODES"
```

Do not guess fields or duplicate the schemas locally. Re-fetch the relevant capability when validation fails or the protocol changes.

## 2. Query the Space

`POST query` accepts one canonical query object. Keep queries bounded. Inspect responses include `count`, `total`, and `truncated`; search responses include `count` and `truncated`. Narrow the predicate or raise the limit within the advertised maximum when results truncate.

```bash
cat > /tmp/huabu-query.json <<'JSON'
{
  "type": "INSPECT_NODES",
  "ids": ["node-123"]
}
JSON

curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  --data-binary @/tmp/huabu-query.json "$HUABU_RFS_URL/query"
```

Use:

- `GET_SPACE_OUTLINE` when whole-Space orientation is necessary; prefer an anchor-specific inspect query when selected-node context already identifies the relevant area.
- `INSPECT_NODES` for identity, type, parent, geometry, proximity, cluster, or topology predicates.
- `INSPECT_EDGES` for endpoints and complete edge style.
- `SEARCH` for bounded literal search across labels, metadata, node bodies, and question conversations.

Query results point to node files. Large bodies and artifacts remain out of band; download only the exact files you need.

## 3. Download files

Selected-node context supplies an exact `file` path. Pass that path through instead of guessing a filename. There is no directory-listing endpoint.

Always write bodies to a file rather than dumping large content into your context. For a node, save response headers too: `X-Huabu-Node-Id`, `X-Huabu-Node-Type`, `X-Huabu-Node-Label`, `X-Huabu-Src`, `X-Huabu-Locked`, `X-Huabu-Node-Edges`, and `ETag`.

```bash
curl -fsS -H "$AUTH" -D /tmp/huabu-headers.txt -o /tmp/node.md \
  "$HUABU_RFS_URL/download/nodes/My%20note.md"
```

The `ETag` is the node's authored-content revision. Cache it and use `If-None-Match` to avoid re-reading unchanged content. Write a conditional response to a temporary file so a `304` cannot replace your cached body with an empty file:

```bash
STATUS="$(curl -sS -H "$AUTH" -H 'If-None-Match: "3d7e"' \
  -D /tmp/huabu-headers.txt -o /tmp/node.next -w '%{http_code}' \
  "$HUABU_RFS_URL/download/nodes/My%20note.md")"
[ "$STATUS" = 200 ] && mv /tmp/node.next /tmp/node.md
[ "$STATUS" = 304 ] && rm -f /tmp/node.next
```

`304 Not Modified` means your cached copy is current. `200` returns the new body and revision. Treat any other status as an error rather than using the temporary body.

## 4. Snapshot visual nodes

Use the `SNAPSHOT_NODES` query when you need to see an `image` or the user's hand-drawn `sketch`. Passing one `frame` ID is sufficient: frame expansion is recursive by definition and includes all nested image and sketch descendants, so do not enumerate every child ID. Notes, text, PDFs, videos, and other non-still node types are not accepted; use `download` for their authored content instead.

Fetch the query capability before constructing a request:

```bash
curl -fsS -H "$AUTH" \
  "$HUABU_RFS_URL/capabilities/queries/SNAPSHOT_NODES"
```

Then submit node IDs obtained from `query`:

```bash
cat > /tmp/huabu-snapshot.json <<'JSON'
{
  "type": "SNAPSHOT_NODES",
  "nodeIds": ["sketch-123"],
  "maxPixels": 1280
}
JSON

curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  --data-binary @/tmp/huabu-snapshot.json "$HUABU_RFS_URL/query"
```

The response is `{ "type": "SNAPSHOT_NODES", "result": { "snapshots": [{ "src", "downloadPath", "width", "height", "originNodeIds" }] } }`. `src` is the bare artifact key accepted by Huabu media-node commands; `downloadPath` is the exact path to retrieve through `GET download/<path>`. Multiple nearby image or sketch nodes may be spatially clustered into one PNG, and `originNodeIds` identifies every contributing node.

```bash
curl -fsS -H "$AUTH" -o /tmp/huabu-snapshot.png \
  "$HUABU_RFS_URL/download/artifacts/sketch-raster-example.png"
```

Snapshots are content-addressed, so repeating an unchanged request reuses the existing artifact. To render only selected strokes from a sketch, use the capability-documented `strokeSubsets` KEEP list. Reduce `maxPixels` when the resulting PNG is too large for a downstream vision model.

## 5. Upload payloads

Stage bytes under a descriptive, unique name. Uploads are inert until an `execute` command references their returned path. Existing names are never overwritten; a collision returns `409`.

```bash
curl -fsS -H "$AUTH" --data-binary @./diagram.png \
  "$HUABU_RFS_URL/upload/diagram.png"
```

The response is `{ "path": "upload/diagram.png", "size": ... }`. Remove an unused staged file with:

```bash
curl -fsS -X DELETE -H "$AUTH" \
  "$HUABU_RFS_URL/upload/diagram.png"
```

## 6. Huabu layout basics

Coordinates use screen-style axes: x increases to the right and y increases downward. A node's `position` is its top-left corner in **parent-local** coordinates: relative to its direct parent frame, or absolute Space coordinates when it is at the root. Query results also expose read-only `absolutePosition`, which resolves the complete parent chain into world coordinates. For root nodes, `position` and `absolutePosition` are equal.

Before placing or resizing relative to existing content, query the relevant nodes with `INSPECT_NODES`; selected-node metadata does not contain authoritative geometry. Use the returned `position` for sibling placement inside the same frame and `absolutePosition` for root-level placement. After a mutation, query again when exact final geometry matters because frame fitting, structured layout, text measurement, and image aspect-ratio normalization may adjust it.

`CREATE_NODES.position` is always required. `size` is optional; when omitted, Huabu starts from these canonical defaults:

| Node type              | Default geometry                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `text`                 | 200px wide; content-driven height                                                    |
| `note`                 | 400px wide; content-driven height (56px nominal layout height)                       |
| `web`, `pdf`, `office` | 400 × 400px                                                                          |
| `video`                | 400 × 300px                                                                          |
| `image`                | 400px wide; height follows the source aspect ratio (300px nominal before resolution) |
| `frame`                | 400 × 300px                                                                          |
| `question`             | 200px wide; content-driven height (80px nominal layout height)                       |

Never pin top-level height for `text` or `question`; change rendered text scale with `data.style.fontSize`. Notes normally auto-size by content but may use an explicit fixed height. For free-form root or frame layouts, a useful starting heuristic is about 50px between nodes and 40px frame padding, adjusted to the actual queried sizes.

Frames default to `free` layout, where child positions remain explicit and parent-local. `column`, `row`, and `grid` are structured layouts configured through `SET_FRAME_LAYOUT`; `gridCount` selects 1–12 tracks (columns for `column` and `grid`, rows for `row`) and defaults to 1. `column` and `row` are masonry: each track stacks independently, so a track holding fewer items pulls its next item up. `grid` additionally aligns rows: every child holds a cell, and a column with no child in a row leaves that cell blank, which is what keeps items in different columns side by side when one column has no counterpart. Structured frames compute final child geometry, so child `position` is only an ordering hint — in `grid` mode it does not decide rows at all. Use the same command's `cells` array to place children: `column` addresses columns, `row` addresses rows, `grid` addresses both. Their default `hug` sizing fits the frame to its content; `manual` preserves a pinned frame size while children still reflow and may overflow. Fetch the `SET_FRAME_LAYOUT` capability before using sizing or track options.

## 7. Execute Space commands

`POST execute` accepts `{ "runId"?: string, "commands": [...] }`. The server owns canvas scope, agent origin, authorship metadata, and generated node/edge IDs; do not send them.

Add the header `X-Huabu-Host-Thread-Id: $HUABU_THREAD_ID` so your edits are attributed to this conversation. Optional — omitting it still applies the write.

The accepted command set is:

| Command                | Purpose                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `CREATE_NODES`         | Create one or more nodes; Huabu assigns node IDs.                                       |
| `DELETE_NODES`         | Delete nodes and their incident edges.                                                  |
| `MERGE_NODE_DATA`      | Patch node label, content, source, or visual style; content writes require `expectRev`. |
| `SET_NODE_PARENT`      | Move nodes into a frame or back to the root.                                            |
| `DISSOLVE_FRAME`       | Remove a frame while keeping its children in the Space.                                 |
| `SET_NODE_GEOMETRY`    | Change node position and/or size.                                                       |
| `REORDER_NODES`        | Change node z-order.                                                                    |
| `CONNECT_NODES`        | Create edges between existing nodes; Huabu assigns edge IDs.                            |
| `DISCONNECT_EDGES`     | Remove edges by ID or endpoint pair.                                                    |
| `SET_EDGE_STYLE`       | Patch edge direction, line shape, dash style, stroke, width, or label.                  |
| `ALIGN_NODES`          | Align existing nodes along one axis.                                                    |
| `DISTRIBUTE_NODES`     | Evenly space three or more existing nodes.                                              |
| `SET_FRAME_LAYOUT`     | Configure a frame's free, column, row, or grid layout.                                  |
| `SET_PORTAL_NODE_PINS` | Pin or unpin source nodes in the workspace World Canvas.                                |

This table is only a navigation summary. For the complete contract of one command—including required fields, parameter types, enums, limits, semantic constraints, result description, and a valid example—fetch its capability:

```bash
COMMAND=SET_FRAME_LAYOUT
curl -fsS -H "$AUTH" \
  "$HUABU_RFS_URL/capabilities/commands/$COMMAND"
```

The response contains `schema`, `constraints`, `result`, and `examples`. Treat `schema` as authoritative rather than inferring parameters from the summary above. Confirm with the user before destructive, broad, or difficult-to-reverse changes.

```bash
cat > /tmp/huabu-execute.json <<'JSON'
{
  "runId": "create-summary",
  "commands": [
    {
      "type": "CREATE_NODES",
      "nodes": [
        {
          "nodeType": "note",
          "data": {
            "label": "Summary",
            "content": "# Summary\n\nDirectly created through Huabu HTTP."
          },
          "position": { "x": 400, "y": 240 }
        }
      ]
    }
  ]
}
JSON

curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  -H "X-Huabu-Host-Thread-Id: $HUABU_THREAD_ID" \
  --data-binary @/tmp/huabu-execute.json "$HUABU_RFS_URL/execute"
```

Commands run in order, failures do not roll back accepted commands, and an accepted subset commits once. Always inspect every entry in `results`; do not infer success from HTTP 200 alone. Read generated node IDs from `results[].nodes` and generated edge IDs from `results[].edges`.

A command cannot refer to a server-assigned ID before you receive it. Create first, read the generated ID, then connect or reparent it in a follow-up request.

For a `MERGE_NODE_DATA` patch that changes `content`, first download the node and copy its unquoted `ETag` into `expectRev`. A missing or stale revision produces an HTTP 200 business result with `applied: false`, `reason: "conflict"`, and a structured conflict. Re-download, reconcile, and submit a new request.

Downloaded node Markdown is a complete Huabu sidecar: server-owned YAML frontmatter followed by the authored Markdown body. `CREATE_NODES.data.content` and `MERGE_NODE_DATA.patch.content` accept the Markdown body only. Never pass the downloaded file verbatim or copy its leading `---` block into `content`; remove exactly the first frontmatter block and preserve everything after its closing fence. Huabu serializes canonical node metadata itself. As a final safety net, an update whose submitted frontmatter `id` matches its target `nodeId` is unwrapped at the server boundary.

`runId` is an optional opaque correlation label of 1–256 characters. It does not need to be unique. When omitted, Huabu generates a fresh `run-<UUID>` value; either way, the response returns the effective value. Reusing one `runId` in adjacent requests does not join them, reject the later request, deduplicate execution, or return an earlier result: every request executes independently and may create another committed delta-log entry carrying the same label. Reuse a value only to correlate related requests; use distinct values when you need to distinguish them.

`runId` is not an idempotency key and provides no retry safety. After a timeout or dropped connection, never blindly retry a mutation—even with the same `runId`: query the Space, reconcile the observed state, then decide whether another command is needed.

The response includes version transition, projected commands, command results, generated IDs, affected IDs, and new revisions. It intentionally excludes Web UI deltas and internal change-review records.

## 8. Create or continue an Agent

Use an Agent when open-ended work benefits from interpretation or a durable visible conversation. Prefer direct `query`, `download`, `upload`, and `execute` for deterministic operations; they work without an internal model provider.

### 8.1 Create and start a Huabu Agent

Plain text creates a visible Agent with the default `huabu` Profile and immediately submits its first prompt:

```bash
SSE="$(curl -fsS -N -H "$AUTH" -H "Content-Type: text/plain" \
  --data-binary @./prompt.txt "$HUABU_RFS_URL/agent")"
THREAD_ID="$(printf '%s\n' "$SSE" | sed -n 's/^: threadId //p' | head -n 1)"
printf '%s\n' "$SSE" | sed -n 's/^data: //p' | tail -n +2
```

The SSE `created` event reports the new Node, thread, effective Profile, and optional parent-connection result. Save `THREAD_ID`.

### 8.2 Continue the Agent

Address the existing thread in the URL. This submits another turn without creating an Agent:

```bash
SSE="$(curl -fsS -N -H "$AUTH" -H "Content-Type: text/plain" \
  --data-binary @./follow-up.txt \
  "$HUABU_RFS_URL/agent/$THREAD_ID/prompt")"
printf '%s\n' "$SSE" | sed -n 's/^data: //p'
```

### 8.3 Choose Profiles or create without starting

For available Profile discovery, launch configuration, create-only requests, optional parent connections, or recursive delegation, load:

```bash
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/skill/agents"
```

## Advanced workflows

Load these authenticated guides only when the request needs them:

- `GET skill/layout` — structured diagrams, grids, flowcharts, roadmaps, and advanced Frame layout.
- `GET skill/tasks` — durable long-horizon Tasks and Runs.
- `GET skill/agents` — available Profiles, Agent creation, launch configuration, continued conversations, and recursive delegation.
- `GET skill/interactive-views` — durable sandboxed HTML Views with Host-owned state, data, navigation, and Agent actions.

```bash
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/skill/tasks"
```

## Error handling

- Validation and transport errors use `{ "message": ..., "code"?: ... }`.
- HTTP 200 execution responses may still contain rejected commands or content conflicts.
- Error messages include a command that reloads this guide.
- Keep full content in downloaded files; use bounded query metadata to decide what to read.
