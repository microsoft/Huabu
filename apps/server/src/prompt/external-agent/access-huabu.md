# Accessing this Huabu Space

You are working with a **Huabu** Space, an infinite visual surface of notes, images, PDFs, sketches, questions, frames, and links. You do not see the Space directly. Use plain HTTP with `curl`, `wget`, `Invoke-RestMethod`, Python `requests`, or Node `fetch`; no custom tool or SDK is required.

Two environment variables are already set:

- `HUABU_RFS_URL` — the base URL for this Space, with no trailing slash.
- `AGENTLET_TOKEN` — the bearer token for every request.

```bash
AUTH="Authorization: Bearer $AGENTLET_TOKEN"
```

Prefer deterministic direct operations:

1. Discover supported queries and commands through `capabilities`.
2. Use `query` for graph, geometry, and content search.
3. Use `download` for full node or artifact bytes.
4. Use `execute` for validated Space commands.
5. Use `agent` only when you deliberately want the optional internal Huabu agent to interpret an open-ended request.

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

## 4. Upload payloads

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

## 5. Execute Space commands

`POST execute` accepts `{ "runId"?: string, "commands": [...] }`. The server owns canvas scope, agent origin, authorship metadata, and generated node/edge IDs; do not send them.

Load the command capability before composing unfamiliar fields. Confirm with the user before destructive, broad, or difficult-to-reverse changes.

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
  --data-binary @/tmp/huabu-execute.json "$HUABU_RFS_URL/execute"
```

Commands run in order, failures do not roll back accepted commands, and an accepted subset commits once. Always inspect every entry in `results`; do not infer success from HTTP 200 alone. Read generated node IDs from `results[].nodes` and generated edge IDs from `results[].edges`.

A command cannot refer to a server-assigned ID before you receive it. Create first, read the generated ID, then connect or reparent it in a follow-up request.

For a `MERGE_NODE_DATA` patch that changes `content`, first download the node and copy its unquoted `ETag` into `expectRev`. A missing or stale revision produces an HTTP 200 business result with `applied: false`, `reason: "conflict"`, and a structured conflict. Re-download, reconcile, and submit a new request.

`runId` is tracing metadata, not an idempotency key. After a timeout or dropped connection, never blindly retry a mutation: query the Space, reconcile the observed state, then decide whether another command is needed.

The response includes version transition, projected commands, command results, generated IDs, affected IDs, and new revisions. It intentionally excludes Web UI deltas and internal change-review records.

## 6. Optional internal agent

`POST agent` is optional. Direct `query`, `download`, `upload`, and `execute` work without an internal model provider. Use the internal agent only for an intentionally open-ended task where model interpretation is valuable.

The response is an SSE stream. Omit `X-Huabu-Thread-Id` to start a live conversation; return the emitted thread ID to continue it. Continuation does not survive a closed handle or Huabu restart.

```bash
curl -N -H "$AUTH" -H "Content-Type: text/plain" \
  --data-binary @./prompt.txt "$HUABU_RFS_URL/agent"
```

## Error handling

- Authenticate every request; missing or invalid bearer credentials return `401`.
- Validation and transport errors use `{ "message": ..., "code"?: ... }`.
- HTTP 200 execution responses may still contain rejected commands or content conflicts.
- Error messages include a command that reloads this guide.
- Keep full content in downloaded files; use bounded query metadata to decide what to read.
