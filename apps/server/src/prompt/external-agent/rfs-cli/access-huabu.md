# Accessing this Huabu Space

You are working with a **Huabu** Space, an infinite visual surface of notes, images, PDFs, sketches, questions, frames, and links. You do not see the Space directly. Use the optional `huabu-rfs` client through the invocation supplied by the host; the examples below abbreviate that invocation as `huabu-rfs`.

Prefer deterministic direct operations:

1. Use `query --help` and `execute --help` to discover supported operations and their current guidance.
2. Use `query` for graph, geometry, and content search.
3. Use `download` for full node or artifact bytes.
4. Use the `SNAPSHOT_NODES` query to render image, sketch, or frame nodes into PNG artifacts you can inspect.
5. Use `execute` for validated Space commands.
6. Use `agent` only when you deliberately want the optional internal Huabu agent to interpret an open-ended request.
7. Discover configured provider services through `service`, read the selected Package Skill, and download its complete Package before use.

## 1. Discover operations

Use command help to learn how to operate on Huabu. The catalogue reports the protocol version, effective read/write permissions, limits, execution semantics, and supported query and command types. Load detailed guidance only for the operation you are about to use:

```bash
huabu-rfs query --help
huabu-rfs query --help INSPECT_NODES
huabu-rfs execute --help CREATE_NODES
huabu-rfs query --help SNAPSHOT_NODES
```

Do not guess fields or duplicate operation guidance locally. Run the relevant help command again when validation fails or the protocol changes.

## 2. Query the Space

`huabu-rfs query` accepts one canonical query object. Keep queries bounded. Inspect responses include `count`, `total`, and `truncated`; search responses include `count` and `truncated`. Narrow the predicate or raise the limit within the advertised maximum when results truncate.

```bash
cat > /tmp/huabu-query.json <<'JSON'
{
  "type": "INSPECT_NODES",
  "ids": ["node-123"]
}
JSON

huabu-rfs query --json-file /tmp/huabu-query.json
```

Use:

- `GET_SPACE_OUTLINE` when whole-Space orientation is necessary; prefer an anchor-specific inspect query when selected-node context already identifies the relevant area.
- `INSPECT_NODES` for identity, type, parent, geometry, proximity, cluster, or topology predicates.
- `INSPECT_EDGES` for endpoints and complete edge style.
- `SEARCH` for bounded literal search across labels, metadata, node bodies, and question conversations.

Query results point to node files. Large bodies and artifacts remain out of band; download only the exact files you need.

## 3. Download files

Selected-node context supplies an exact `file` path. Pass that path through instead of guessing a filename. There is no directory-listing endpoint.

Always select an output file rather than dumping large content into your context. The command writes NDJSON lifecycle events to stdout: `download_started` includes available file and node metadata, periodic `download_progress` events keep long transfers visible, and `download_completed` means the file was atomically published. A failed transfer exits nonzero, never emits `download_completed`, and preserves an existing output file.

```bash
huabu-rfs download \
  --output /tmp/node.md \
  "nodes/My note.md"
```

The `download_started` event includes `revision` for authored node content. Cache it and use `--if-revision` to avoid re-reading unchanged content:

```bash
huabu-rfs download \
  --output /tmp/node.md \
  --if-revision 3d7e \
  "nodes/My note.md"
```

An unchanged file emits `not_modified` and preserves the existing output. Otherwise wait for `download_completed` before reading the file.

## 4. Snapshot visual nodes

Use the `SNAPSHOT_NODES` query when you need to see an `image` or the user's hand-drawn `sketch`. Passing one `frame` ID is sufficient: frame expansion is recursive by definition and includes all nested image and sketch descendants, so do not enumerate every child ID. Notes, text, PDFs, videos, and other non-still node types are not accepted; use `download` for their authored content instead.

Load the current query guidance before constructing a request:

```bash
huabu-rfs query --help SNAPSHOT_NODES
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

huabu-rfs query --json-file /tmp/huabu-snapshot.json
```

The response is `{ "type": "SNAPSHOT_NODES", "result": { "snapshots": [{ "src", "downloadPath", "width", "height", "originNodeIds" }] } }`. `src` is the bare artifact key accepted by Huabu media-node commands; pass `downloadPath` directly to `huabu-rfs download`. Multiple nearby image or sketch nodes may be spatially clustered into one PNG, and `originNodeIds` identifies every contributing node.

```bash
huabu-rfs download \
  --output /tmp/huabu-snapshot.png \
  artifacts/sketch-raster-example.png
```

Snapshots are content-addressed, so repeating an unchanged request reuses the existing artifact. To render only selected strokes from a sketch, use the help-documented `strokeSubsets` KEEP list. Reduce `maxPixels` when the resulting PNG is too large for a downstream vision model.

## 5. Upload payloads

Stage bytes under a descriptive, unique name. Uploads are inert until an `execute` command references their returned path. Existing names are never overwritten; a collision returns `409`.

```bash
huabu-rfs upload --file ./diagram.png diagram.png
```

The response is `{ "path": "upload/diagram.png", "size": ... }`. Remove an unused staged file with:

```bash
huabu-rfs upload --delete diagram.png
```

## 6. Huabu layout basics

Coordinates use screen-style axes: x increases to the right and y increases downward. A node's `position` is its top-left corner in **parent-local** coordinates: relative to its direct parent frame, or absolute Space coordinates when it is at the root. Query results also expose read-only `absolutePosition`, which resolves the complete parent chain into world coordinates. For root nodes, `position` and `absolutePosition` are equal.

Before placing or resizing relative to existing content, query the relevant nodes with `INSPECT_NODES`; selected-node metadata does not contain authoritative geometry. Use the returned `position` for sibling placement inside the same frame and `absolutePosition` for root-level placement. After a mutation, query again when exact final geometry matters because frame fitting, structured layout, text measurement, and image aspect-ratio normalization may adjust it.

`CREATE_NODES.position` is always required. `size` is optional; when omitted, Huabu starts from these canonical defaults:

| Node type              | Default geometry                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `text`                 | 400px wide; content-driven height                                                    |
| `note`                 | 400 × 300px; fixed height by default                                                 |
| `web`, `pdf`, `office` | 400 × 400px                                                                          |
| `video`                | 400 × 300px                                                                          |
| `image`                | 400px wide; height follows the source aspect ratio (300px nominal before resolution) |
| `frame`                | 400 × 300px                                                                          |
| `question`             | 400px wide; content-driven height (80px nominal layout height)                       |

Never pin top-level height for `text` or `question`. Both respect `data.style.fontSize`: Text defaults to 16px and Question to 24px. The font also scales content padding and, for Question, the avatar, alias, status, and gaps; Question chrome retains a separate 28px design basis. Width-only edits preserve the font and reflow content-driven height; proportional canvas resize gestures scale the font with outer width. Existing Question font values are respected without automatic persisted-data migration. New Notes default to fixed height; use `SET_NODE_GEOMETRY` with `size.height: "auto"` to fit a Note to its content. Resizing their container preserves fixed typography and reflows or scrolls the document rather than scaling its font. For free-form root or frame layouts, a useful starting heuristic is about 50px between nodes, 28px side/bottom Frame padding, and an 80px top inset for a Regular internal Frame title, adjusted to the actual queried sizes.

Frames default to `free` layout, where child positions remain explicit and parent-local. `column`, `row`, and `grid` are structured layouts configured through `SET_FRAME_LAYOUT`; `gridCount` selects 1–12 tracks (columns for `column` and `grid`, rows for `row`) and defaults to 1. `column` and `row` are masonry: each track stacks independently, so a track holding fewer items pulls its next item up. `grid` additionally aligns rows: every child holds a cell, and a column with no child in a row leaves that cell blank, which is what keeps items in different columns side by side when one column has no counterpart. Structured frames compute final child geometry, so child `position` is only an ordering hint — in `grid` mode it does not decide rows at all. Use the same command's `cells` array to place children: `column` addresses columns, `row` addresses rows, `grid` addresses both. Their default `hug` sizing fits the frame to its content; `manual` preserves a pinned frame size while children still reflow and may overflow. Run `huabu-rfs execute --help SET_FRAME_LAYOUT` before using sizing or track options.

## 7. Execute Space commands

`huabu-rfs execute` accepts `{ "runId"?: string, "commands": [...] }`. Huabu owns Space scope, agent origin, authorship metadata, and generated node/edge IDs; do not send them.

The CLI adds available conversation correlation automatically; no request header setup is required.

The accepted command set is:

| Command             | Purpose                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `CREATE_NODES`      | Create one or more nodes; Huabu assigns node IDs.                                       |
| `DELETE_NODES`      | Delete nodes and their incident edges.                                                  |
| `MERGE_NODE_DATA`   | Patch node label, content, source, or visual style; content writes require `expectRev`. |
| `SET_NODE_PARENT`   | Move nodes into a frame or back to the root.                                            |
| `DISSOLVE_FRAME`    | Remove a frame while keeping its children in the Space.                                 |
| `SET_NODE_GEOMETRY` | Change node position and/or size.                                                       |
| `REORDER_NODES`     | Change node z-order.                                                                    |
| `CONNECT_NODES`     | Create edges between existing nodes; Huabu assigns edge IDs.                            |
| `DISCONNECT_EDGES`  | Remove edges by ID or endpoint pair.                                                    |
| `SET_EDGE_STYLE`    | Patch edge direction, line shape, dash style, stroke, width, or label.                  |
| `ALIGN_NODES`       | Align existing nodes along one axis.                                                    |
| `DISTRIBUTE_NODES`  | Evenly space three or more existing nodes.                                              |
| `SET_FRAME_LAYOUT`  | Configure a frame's free, column, row, or grid layout.                                  |

This table is only a navigation summary. Load the current guidance for one command—including required fields, parameter types, enums, limits, semantic constraints, result description, and a valid example—before using it:

```bash
COMMAND=SET_FRAME_LAYOUT
huabu-rfs execute --help "$COMMAND"
```

Treat the returned operation guidance as authoritative rather than inferring parameters from the summary above. Confirm with the user before destructive, broad, or difficult-to-reverse changes.

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
            "content": "# Summary\n\nCreated through Huabu."
          },
          "position": { "x": 400, "y": 240 }
        }
      ]
    }
  ]
}
JSON

huabu-rfs execute --json-file /tmp/huabu-execute.json
```

Commands run in order, failures do not roll back accepted commands, and an accepted subset commits once. Always inspect every entry in `results`; successful delivery does not mean every command was applied. Read generated node IDs from `results[].nodes` and generated edge IDs from `results[].edges`.

A command cannot refer to a Huabu-assigned ID before you receive it. Create first, read the generated ID, then connect or reparent it in a follow-up request.

For a `MERGE_NODE_DATA` patch that changes `content`, first download the node and copy its `revision` metadata into `expectRev`. A missing or stale revision produces `applied: false`, `reason: "conflict"`, and a structured conflict. Re-download, reconcile, and submit a new request.

Downloaded node Markdown is a complete Huabu sidecar: Huabu-owned YAML frontmatter followed by the authored Markdown body. `CREATE_NODES.data.content` and `MERGE_NODE_DATA.patch.content` accept the Markdown body only. Never pass the downloaded file verbatim or copy its leading `---` block into `content`; remove exactly the first frontmatter block and preserve everything after its closing fence. Huabu serializes canonical node metadata itself. As a final safety net, an update whose submitted frontmatter `id` matches its target `nodeId` is unwrapped before execution.

`runId` is an optional opaque correlation label of 1–256 characters. It does not need to be unique. When omitted, Huabu generates a fresh `run-<UUID>` value; either way, the response returns the effective value. Reusing one `runId` in adjacent requests does not join them, reject the later request, deduplicate execution, or return an earlier result: every request executes independently and may create another committed delta-log entry carrying the same label. Reuse a value only to correlate related requests; use distinct values when you need to distinguish them.

`runId` is not an idempotency key and provides no retry safety. After a timeout or dropped connection, never blindly retry a mutation—even with the same `runId`: query the Space, reconcile the observed state, then decide whether another command is needed.

The response includes version transition, projected commands, command results, generated IDs, affected IDs, and new revisions. It intentionally excludes Web UI deltas and internal change-review records.

## 8. Create or continue an Agent

Use an Agent when open-ended work benefits from interpretation or a durable visible conversation. Prefer direct `query`, `download`, `upload`, and `execute` for deterministic operations; they work without an internal model provider.

### 8.1 Create and start an Agent

Plain text creates a visible Agent with the first selectable external Profile and immediately submits its first prompt. This Huabu fallback does not read the Web client's browser-local recent selection:

```bash
SSE="$(huabu-rfs agent create --text-file ./prompt.txt)"
THREAD_ID="$(printf '%s\n' "$SSE" | sed -n 's/^: threadId //p' | head -n 1)"
printf '%s\n' "$SSE" | sed -n 's/^data: //p' | tail -n +2
```

`huabu-rfs agent create` streams standard SSE to stdout. The stream starts with `: threadId <id>`, then emits a `created` event whose JSON data reports the new Node, thread, effective Profile, and optional parent-connection result. In the default final mode, later `data:` frames carry the final answer; heartbeat comments can be ignored and `event: error` reports Agent failure. Save `THREAD_ID`. Run `huabu-rfs agent --help` for the complete creation, event, Profile, and continuation workflow.

### 8.2 Continue the Agent

Address the existing thread in the URL. If you know the Agent Node but did not retain its creation response, query that Node first; a Question Node with an existing association includes `threadId`:

```bash
THREAD_ID="$(huabu-rfs query \
  --json '{"type":"INSPECT_NODES","ids":["node-123"]}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).result.nodes[0]?.threadId ?? ""))')"

SSE="$(huabu-rfs agent prompt --text-file ./follow-up.txt "$THREAD_ID")"
printf '%s\n' "$SSE" | sed -n 's/^data: //p'
```

An absent `threadId` means the result is not a Question Node with an existing thread association. Inspection is read-only and never creates or realizes Agent state. Submitting the prompt continues the associated conversation without creating another Agent or changing its Profile.

### 8.3 Choose Profiles or create without starting

For available Profile discovery, launch configuration, create-only requests, optional parent connections, or recursive delegation, load:

```bash
huabu-rfs agent --help
```

## Provider Services

List the bundled provider services that Huabu can provision:

```bash
huabu-rfs service list
```

Before using one, fetch and follow its Skill:

```bash
huabu-rfs service skill image-gen
```

Download the complete Package to a path in your working directory:

```bash
huabu-rfs service download --out-folder . image-gen
cd image-gen
```

Every archive contains one top-level directory named after the Service, so extracting `image-gen.zip` creates `image-gen/` rather than placing files directly in the current directory. `service.yaml` and every file declared by `package.files` are included; undeclared development files are not.

Read the extracted `SKILL.md` before using the Package. Run Service help for complete discovery, download, entry, custom operation, and private lease guidance:

```bash
huabu-rfs service --help
```

## Advanced workflows

Load these focused guides only when the request needs them:

- `layout` — structured diagrams, grids, flowcharts, roadmaps, and advanced Frame layout.
- `agents` — available Profiles, Agent creation, launch configuration, continued conversations, and recursive delegation.
- `services` — Service discovery, Package download, entries, custom operations, and private configuration leases.

```bash
huabu-rfs get-skill layout
```

## Error handling

- Invalid input, unavailable operations, content conflicts, and connection failures are reported explicitly.
- A delivered execution response may still contain rejected commands or content conflicts; inspect every result.
- CLI error messages direct you to `huabu-rfs get-skill` when the current Space guide can help.
- Keep full content in downloaded files; use bounded query metadata to decide what to read.
