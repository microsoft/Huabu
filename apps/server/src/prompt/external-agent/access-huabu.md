# Accessing this Huabu Space

You are working with a **Huabu** Space (an infinite visual Space of _nodes_: notes, images, PDFs, sketches, questions, …). You do **not** see the Space directly. You reach into it over plain HTTP through the **Remote File System (RFS)** — no custom tool or SDK required, just `curl` (or `wget`, `Invoke-RestMethod`, `python requests`, Node `fetch`).

Two environment variables are already set for you:

- `HUABU_RFS_URL` — the base URL for this Space, e.g. `http://host:port/api/rfs/<canvasId>` (no trailing slash).
- `AGENTLET_TOKEN` — your bearer token. Send it on **every** request: `Authorization: Bearer $AGENTLET_TOKEN`.

There are two ways to work:

1. **RFS files** — download/upload bytes by path.
2. **ask-agent** — talk to the Space's own internal agent for anything structural (creating/moving/linking nodes, layout, snapshots, discovery).

---

## 1. Download a file — `GET download/<path>`

Fetch any file under the Space by its path. Node content lives at `nodes/<label>.md`; you are handed the exact `file` path for each selected node — pass it straight through (URL-encode spaces / unicode).

**Always download to a file with `-o` and then read it as needed** — don't let response bodies stream straight into your context. Node/artifact contents can be large, and dumping them to stdout wastes your context window; save to disk, then open only the parts you need.

For a node file, the response carries the node's metadata in headers: `X-Huabu-Node-Id`, `X-Huabu-Node-Type`, `X-Huabu-Node-Label` (percent-encoded UTF-8 — URL-decode it), `X-Huabu-Src`, `X-Huabu-Locked`, and `X-Huabu-Node-Edges` (a JSON string `{"parents":[...],"children":[...]}` of neighbour node ids). To save the body **and** see those headers in one command, dump headers with `-D` while writing the body with `-o`:

```bash
AUTH="Authorization: Bearer $AGENTLET_TOKEN"
curl -fsS -H "$AUTH" -D - -o note.md "$HUABU_RFS_URL/download/nodes/My%20note.md"
# headers → stdout, body → note.md. Use -D /dev/stderr to keep stdout clean,
# or add | grep -i '^x-huabu' to see only the metadata.
```

You're supposed to **never** guess node paths -- the file path is supposed to be provided in the user instructions and the context. In some legacy cases, you may see some artifacts only with a filename like `src: artifact_ab12cd.png` (no directory). In that case, you can fetch it with `GET download/artifacts/artifact_ab12cd.png`. Except for that, you should **never** assume any directory structure or naming convention. IF you need to discover which files matter, ask the agent (see below -- _Talk to the Space agent_).

There is **no directory listing** — to discover which files matter, ask the agent (below).

### Skip re-downloading unchanged nodes — `ETag`

Each node download returns an `ETag` (its content revision; also shown as `rev="…"` beside each node in your context). Remember it and send it back as `If-None-Match` next time: unchanged → `304 Not Modified` (empty body — reuse your copy); changed → `200` with a new `ETag`.

```bash
curl -fsS -H "$AUTH" -H 'If-None-Match: "3d7e"' -D - -o note.md \
  "$HUABU_RFS_URL/download/nodes/My%20note.md"
# 304 → still current, skip re-reading;  200 → changed, re-read.
```

## 2. Upload a file — `POST upload/<file>`

Stage a payload the internal agent can consume (e.g. content for a new node). Uploads go to a shared scratch area — pick a **descriptive, unique** name. Re-using an existing name is rejected (409); choose another.

```bash
curl -fsS -H "$AUTH" --data-binary @./summary.md \
  "$HUABU_RFS_URL/upload/summary.md"
# → 201 { "path": "upload/summary.md", "size": 1234 }
```

Remove a staged file with `DELETE`:

```bash
curl -fsS -X DELETE -H "$AUTH" "$HUABU_RFS_URL/upload/summary.md"
```

## 3. Talk to the Space agent — `POST agent`

For anything the Space needs to _understand_ — creating nodes, moving/linking them, laying out frames, rendering sketches, or finding relevant nodes — send a natural-language prompt to the internal agent. It owns all Space mutations.

The response is **always** an event stream (`text/event-stream`): comment heartbeats (`: ping`) keep the connection alive during long turns, `: threadId <id>` identifies the live conversation, and the final answer arrives as plain text inside `data:` frames.

```bash
curl -N -H "$AUTH" -H "Content-Type: text/plain" \
  --data-binary @./prompt.txt "$HUABU_RFS_URL/agent" \
  | tee /tmp/huabu-agent.sse

THREAD_ID="$(sed -n 's/^: threadId //p' /tmp/huabu-agent.sse | head -1)"
sed -n 's/^data: //p' /tmp/huabu-agent.sse
```

Continue the same live conversation by returning that ID:

```bash
curl -N -H "$AUTH" -H "Content-Type: text/plain" \
  -H "X-Huabu-Thread-Id: $THREAD_ID" \
  --data-binary @./follow-up.txt "$HUABU_RFS_URL/agent"
```

Request headers:

- `X-Huabu-Thread-Id` — continue the live conversation returned by a prior call; omit it to create a new conversation.
- `X-Huabu-Event-Mode` — `final` (default) returns only the final answer plus protocol comments; `all` also returns structured intermediate events.
- `X-Huabu-Heartbeat-Sec` — heartbeat cadence from `5` to `30` seconds (default `15`).

Typical asks:

- "Create a `note` from `upload/summary.md`, place it near `node-123`, and link `node-123` → the new node."
- "Which node files relate to the authentication design?" → returns concrete `file` paths you can then `download`.
- "Render the sketches around `node-123` as PNGs." → the agent writes them to `artifacts/`; download each with `GET download/artifacts/<key>.png`.

---

## Notes

- **Auth every request.** Missing/invalid bearer → `401`.
- **Errors** use `{ "message": ... }`; on failure the message includes a ready-to-run command to re-fetch this guide.
- **Continuation is live-only.** If Huabu restarts or the handle is closed, start a new conversation by omitting `X-Huabu-Thread-Id`.
- **Snapshots / vision:** sketch and image nodes are not readable as text — ask the agent to render them, then download the PNG.
