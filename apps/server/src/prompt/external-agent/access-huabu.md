# Accessing this Huabu canvas

You are working with a **Huabu** canvas (an infinite visual workspace of _nodes_: notes, images, PDFs, sketches, questions, …). You do **not** see the canvas directly. You reach into it over plain HTTP through the **Remote File System (RFS)** — no custom tool or SDK required, just `curl` (or `wget`, `Invoke-RestMethod`, `python requests`, Node `fetch`).

Two environment variables are already set for you:

- `HUABU_RFS_URL` — the base URL for this canvas, e.g. `http://host:port/api/rfs/<canvasId>` (no trailing slash).
- `AGENTLET_TOKEN` — your bearer token. Send it on **every** request: `Authorization: Bearer $AGENTLET_TOKEN`.

There are two ways to work:

1. **RFS files** — download/upload bytes by path.
2. **ask-agent** — talk to the canvas's own internal agent for anything structural (creating/moving/linking nodes, layout, snapshots, discovery).

---

## 1. Download a file — `GET download/<path>`

Fetch any file under the canvas by its path. Node content lives at `nodes/<label>.md`; you are handed the exact `file` path for each selected node — pass it straight through (URL-encode spaces / unicode).

```bash
AUTH="Authorization: Bearer $AGENTLET_TOKEN"
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/download/nodes/My%20note.md"
```

For a node file, the response carries a small metadata subset in headers: `X-Huabu-Node-Id`, `X-Huabu-Node-Type`, `X-Huabu-Src`, `X-Huabu-Locked`.

To save the body **and** see those headers in one command, dump headers with `-D` while writing the body with `-o`:

```bash
curl -fsS -H "$AUTH" -D - -o note.md "$HUABU_RFS_URL/download/nodes/My%20note.md"
# headers → stdout, body → note.md. Use -D /dev/stderr to keep stdout clean,
# or add | grep -i '^x-huabu' to see only the metadata.
```

Ask for JSON to get metadata + content + edges in one shot:

```bash
curl -fsS -H "$AUTH" -H "Accept: application/json" \
  "$HUABU_RFS_URL/download/nodes/My%20note.md"
# → { "meta": {id,type,label,src?,locked?}, "content": "...", "edges": [...] }
```

Artifacts (images, rendered PNGs, uploaded files) live under `artifacts/`:

```bash
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/download/artifacts/<key>.png" -o out.png
```

There is **no directory listing** — to discover which files matter, ask the agent (below).

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

## 3. Talk to the canvas agent — `POST agent`

For anything the canvas needs to _understand_ — creating nodes, moving/linking them, laying out frames, rendering sketches, or finding relevant nodes — send a natural-language prompt to the internal agent. It owns all canvas mutations.

The response is **always** an event stream (`text/event-stream`): comment heartbeats (`: ping`) keep the connection alive during long turns, and the final answer arrives as plain text inside `data:` frames. Use a streaming client (`curl -N`) and strip the framing:

```bash
curl -N -H "$AUTH" -H "Content-Type: text/plain" \
  --data-binary @./prompt.txt "$HUABU_RFS_URL/agent" \
  | sed -n 's/^data: //p'
# (PowerShell: ... | Select-String '^data: ')
```

Or send JSON with options:

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"prompt":"Create a note from upload/summary.md near node-123 and link them", "doneTextOnly":true, "heartbeatSec":10}' \
  "$HUABU_RFS_URL/agent" | sed -n 's/^data: //p'
```

Body options:

- `prompt` (required) — what you want done or answered.
- `doneTextOnly` (default `true`) — emit only the final answer text as `data:` frames (best for the `sed` one-liner). Set `false` to also receive structured intermediate events (`event: tool_call`, etc.).
- `heartbeatSec` (default `15`, clamped to `[5, 30]`) — heartbeat cadence.

Typical asks:

- "Create a `note` from `upload/summary.md`, place it near `node-123`, and link `node-123` → the new node."
- "Which node files relate to the authentication design?" → returns concrete `file` paths you can then `download`.
- "Render the sketches around `node-123` as PNGs." → the agent writes them to `artifacts/`; download each with `GET download/artifacts/<key>.png`.

---

## Notes

- **Auth every request.** Missing/invalid bearer → `401`.
- **Errors** use `{ "message": ... }`; on failure the message includes a ready-to-run command to re-fetch this guide.
- **Snapshots / vision:** sketch and image nodes are not readable as text — ask the agent to render them, then download the PNG.
