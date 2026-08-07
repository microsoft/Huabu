# Reachback v2 — RFS + ask-agent

> Rethinks how external agents reach back into Huabu. Instead of a shipped
> `.mjs` reachback tool with node-CRUD verbs (`read-node` / `write-node` /
> `snapshot`), external agents get **three plain-`curl` endpoints** — `download`
> / `upload` / `agent` — with **no client tool at all**: a **Remote File System
> (RFS)** view for moving bytes, and **`ask-agent`** for everything
> canvas-semantic. A single internal agent is the only writer to the canvas graph.
>
> Status: **Shipped** · Last updated: 2026-07-22
>
> Current behavior is documented in [`../architecture/agent-reachback.md`](../architecture/agent-reachback.md). The direct-operation extension is tracked in [`direct-space-operations.md`](./direct-space-operations.md) and [issue #348](https://github.com/hai-team/Huabu/issues/348).
>
> Supersedes the shortcut design recorded in
> [`../archive/agent-reachback.md`](../archive/agent-reachback.md)
> (`read-node`, `write-node`, `snapshot`). The agentlet transport layer
> ([Agent Reachback Interface](../../external/agentlet/spec/agent-reachback.md))
> is unchanged.

---

## 0. TL;DR

External agents interact with Huabu through plain-`curl` endpoints (no
client tool) under `$HUABU_RFS_URL` — three core operations grouped into two
surfaces, plus a `skill` bootstrap endpoint:

| Surface         | Endpoint(s)           | Plane     | What it does                                                                            |
| --------------- | --------------------- | --------- | --------------------------------------------------------------------------------------- |
| **RFS**         | `download` / `upload` | Data      | Move bytes by **path** (download) / filename (upload). **No canvas semantics.**         |
| **`ask-agent`** | `agent`               | Control   | All node manipulation, linking, layout, spatial/semantic queries.                       |
| **skill**       | `skill`               | Bootstrap | `GET`s the canvas-access guide (per-canvas override → default); pulled on demand (§6c). |

The canvas is projected as a filesystem that is **read-only everywhere except
`/upload/`**. Uploads land in `/upload/` as inert files; they do **not** become
nodes. Only the internal agent (via `ask-agent`) ever mutates the canvas graph —
a **single-writer** model.

```
External agent
   │  download /canvas resources (read-only)        ┌──────────────┐
   │  upload payloads → /upload (write)             │ Internal     │
   ▼                                                │ agent        │
 RFS  ──────────────────────────────────────────▶  │ (sole writer)│
   │  ask-agent "make a note from upload/x.md       └──────┬───────┘
   │            near node-123, link it back"               │ CanvasCommand[]
   ▼                                                        ▼
 result / new node id                                   Canvas graph
```

## 1. Why replace the node-CRUD shortcuts

The v1 shortcuts (`read-node`, `write-node`, `snapshot`) each encode a bit of
canvas semantics as CLI flags (`--type`, `--link-to`, `--link-from`, `--notify`,
snapshot clustering). That surface only grows as the canvas model grows, and it
asks an external coding agent to learn a bespoke node vocabulary.

Two observations make a smaller design possible:

1. **A canvas is already a self-contained directory on disk**
   ([`canvas-storage.md`](../architecture/canvas-storage.md)): `canvas.json`,
   `nodes/<label>.md`, `.artifacts/<key><ext>`. Exposing (a projection of) that
   tree over the reachback channel is a natural, familiar interface — an
   external coding agent already thinks in files.
2. **Everything that isn't "move these bytes" is inherently semantic/spatial**
   — placement, linking, framing, clustering, neighbour discovery — and already
   benefits from LLM reasoning. That is exactly what `ask-agent` is for.

So: bytes → RFS; meaning → `ask-agent`. Nothing in between.

## 2. Single-writer model

**Only the internal agent writes to the canvas graph.** The external agent can
read canvas resources and can park payloads in `/upload/`, but a payload is inert
until an `ask-agent` call materializes it. Consequences:

- Canvas invariants (types, positions, edges) are always enforced by one code
  path — the internal agent emitting `CanvasCommand[]`.
- No optimistic-concurrency / CAS problem on the external write path: external
  agents never write nodes, so there is nothing to conflict.
- Uploads are **payloads, not mutations**. Materialization is an explicit,
  auditable `ask-agent` transaction that returns the new node id.

Trade-off accepted: every structural write costs one `ask-agent` round-trip
(LLM latency + cost). We judge this acceptable because structural writes are the
low-frequency tail; high-frequency work is _reading_ context, which stays a
deterministic RFS download.

## 3. RFS layout & addressing

One tree, scoped to the canvas (the `canvasId` is baked into `HUABU_RFS_URL`).
Read-only everywhere except `/upload/`.

```
/                              # canvas root (read-only)
  canvas.json                  # metadata (read-only)
  nodes/<node-id>.md           # node content, flat by stable id (read-only)
  artifacts/<key><ext>         # raw uploads / renders (read-only)
  upload/                      # THE ONLY writable region (shared scratch)
    <filename.ext>             # inert payloads, natural filenames
```

- **Downloads are addressed by the server-provided `filename` path — never by
  id.** Each turn Huabu hands the agent its selected refs; every ref already
  carries a precomputed path:

  ```json
  {
    "id": "node-cbf9…",
    "type": "image",
    "filename": "nodes/Brainstorming whiteboard diagram.md",
    "label": "Brainstorming whiteboard diagram",
    "preview": "artifact-9730…-…jpg"
  }
  ```

  The agent downloads `filename` directly (`GET $RFS/download/nodes/Brainstorming%20whiteboard%20diagram.md`).
  `filename` is `nodes/<safeLabel>.md` (falling back to `nodes/<id>.md` only for
  label-less nodes) — see
  [`apps/server/src/modules/agent/node-ref.ts`](../../apps/server/src/modules/agent/node-ref.ts).
  The `id` is used **only** to identify a node in an `ask-agent` request, never
  for download addressing.

- **Filenames are real, human-readable, label-based paths and may contain spaces
  / unicode** → the agent must URL-encode them in the curl path. Frames /
  hierarchy / spatial layout are **not** modelled in the FS — they are
  `ask-agent`'s concern.
- **Binary / image nodes**: `filename` (`.md`) holds the node's content +
  metadata; the _viewable bytes_ are the ref's `preview` artifact
  (`artifact-…jpg`), downloaded at `GET $RFS/download/artifacts/<preview>`.
- **Discovery beyond the selection**: handled by **`ask-agent`**, not a directory
  listing. Finding _which_ files matter is a canvas-semantic judgment (relevance,
  neighbourhood, layout), so the agent asks `POST $RFS/agent` ("which node files
  relate to X?") and gets back concrete `filename` paths to `download`. The RFS
  download surface is deliberately path-only: no listing/enumeration.
- Uploads go through a dedicated **`POST /upload/<filename>`** action endpoint;
  the payload lands directly in the single shared `/upload/` folder (no
  per-session subtree — an external agent has no reliable handle on its own
  session id at tool-call time). On disk `/upload/` is a **hidden** `.upload/`
  dir inside the canvas dir (consistent with `.artifacts/` / `.memory/`), so it
  is never scanned as a node or shown to users. Because the folder is shared,
  agents should pick descriptive/unique filenames; the internal agent deletes
  payloads once consumed.

### Read scope

`/canvas` exposes the canvas **read-only**, limited to `nodes/` + `artifacts/` +
`upload/`. The `.`-prefixed private dirs (`.memory/`, `.history/`, internal
bookkeeping) are **never** projected. Download is **path-only** — there is no
directory listing; the agent obtains paths from the refs it was handed or by
asking `ask-agent`. Under single-writer this read projection is low-risk (nothing
external can mutate) and the biggest ergonomic win: once the agent knows a path it
pulls that node's content via a plain download instead of an `ask-agent` round-trip
for the bytes. Acceptable in phase 1 because external agents are first-party and
trusted; canvas-scoped tokens are a later hardening step (§7).

## 4. RFS operations — three core operations, zero client tool

The whole reachback surface is **three core curl-able operations** under
`$HUABU_RFS_URL` — `download` / `upload` / `agent` (plus a `GET skill` bootstrap
endpoint, §6c). There is **no `.mjs`
reachback tool**; these endpoints fully replace it (see §6a for the feasibility
mapping). Each operation is a single `curl`:

| Operation        | Region     | HTTP                            | Notes                                                                                                           |
| ---------------- | ---------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| download content | read-only  | `GET $RFS/download/<path>`      | `<path>` = the ref's `filename` (path-only, no id, no listing). Bytes in body; metadata in `X-Huabu-*` headers. |
| upload payload   | `/upload/` | `POST $RFS/upload/<filename>`   | Body = bytes → stored at `upload/<filename>`. Optional metadata headers (e.g. `Author`).                        |
| remove payload   | `/upload/` | `DELETE $RFS/upload/<filename>` | Clean up shared scratch.                                                                                        |
| ask agent        | via agent  | `POST $RFS/agent`               | Prompt in body; streams the answer (§5, §6).                                                                    |

The upload endpoint carries any provenance hints in **headers** and the payload
bytes in the body; the filename is in the URL. `/upload/` is a **single shared**
scratch folder (no session segment), so agents should choose descriptive/unique
filenames to avoid clobbering each other; the internal agent removes payloads
once consumed.

### Snapshots are a two-step: `agent` renders → `download`

Rendering is **never** a `download` modifier — `download` only fetches bytes that
already exist. All rasterization (both single-node and _nearby_ sketch+image
clusters, an inherently spatial many→one operation) goes through `ask-agent`:

1. `POST agent` — "render \<these nodes\> as PNG(s)"; the internal agent runs the
   existing `snapshot_nodes` tool, which writes content-addressed PNG(s) into the
   canvas `.artifacts/` store and returns their artifact keys.
2. `GET download/artifacts/<key>.png` — the external agent fetches the result
   (artifacts are already in the read scope; no write into `/upload/` needed).

This keeps the three endpoints uniform (`download` = pure fetch) at the cost of
one extra round-trip for vision — an acceptable trade since snapshots are
low-frequency.

## 5. ask-agent (expanded role)

`ask-agent` is unchanged in transport (SSE streaming, blocking, timeout-resistant
— see [agent-reachback.md §Sync/Async](../architecture/agent-reachback.md)) but
gains responsibility for **all** structural work, and can now reference `/upload/`
payloads. Representative requests:

- "Create a `note` from `upload/summary.md`, place it near `node-123`, link
  `node-123` → the new node." → internal agent reads the staged file, emits
  add-node + add-edge `CanvasCommand`s, returns the new node id.
- "Arrange these three nodes into a frame titled 'Findings'."
- "Render the sketches around `node-123` as PNGs." → internal agent runs
  `snapshot_nodes` (writes to `.artifacts/`); the external agent then downloads
  `download/artifacts/<key>.png`.
- "What nodes discuss auth, and where are they on the canvas?" (semantic/spatial
  query — unchanged from v1).

The internal agent needs read access to `/upload/`; since `.upload/` lives inside
the canvas dir, its existing file/canvas tools reach it natively (a dedicated
`read_staging` tool may be added for clarity).

**Streaming — one transport: SSE (`text/event-stream`) always.** `POST $RFS/agent`
always responds `Content-Type: text/event-stream`, so a plain `curl -N` keeps the
connection (and the agentlet harness) alive and is timeout-resistant. There is **no
separate `text/plain` mode** — instead, the SSE _envelope_ carries **plain text
inside `data:` frames**, which keeps the wire heartbeat-safe _and_ the clean
extraction parser-free.

Mental model — the media type describes the **envelope (framing)**, not the frame
contents. The bytes follow SSE grammar (`data:` frames, `\n\n` separators, `:`
comment heartbeats, `event:` names); the _content_ of each `data:` frame is plain
answer text (not JSON). Those two are orthogonal.

```
Content-Type: text/event-stream

: ping                      ← heartbeat: SSE comment, ignored by parsers & `sed`
data: The answer starts…    ← plain text inside a data: frame (streamed as generated)
data: …and continues.
event: done                 ← terminator (+ threadId)
data: {"threadId":"…"}
```

- **Clean answer, no parser** (default path):
  ```bash
  curl -N -H "$AUTH" --data-binary @prompt.md "$HUABU_RFS_URL/agent" | sed -n 's/^data: //p'
  # heartbeats (`: ping`) are ignored; you get just the answer text. Cross-platform:
  # PowerShell → ... | Select-String '^data: '
  ```
- **Full steps** (advanced): read the whole SSE stream (`event: step` / tool frames
  - `done` + `error`) with a real client/parser.

**Heartbeats are timer-driven**, not event-driven: the server emits `: ping\n\n`
every `heartbeatSec` seconds regardless of agent activity, because a single long
tool call can be silent longer than a proxy/harness idle timeout. `X-Accel-Buffering:
no` (already set on the v1 reachback route) ensures the frames flush immediately.

**Request body — `text/plain` (prompt only) or JSON (with options):**

```jsonc
// raw text/plain body → the prompt, all options default
// — or — application/json:
{
  "prompt": "…", // required
  "doneTextOnly": true, // default true → emit ONLY final answer text as data: frames
  //   (+ heartbeats/done/error). Set false to also get
  //   event: step / tool frames — then use a real parser,
  //   since the sed one-liner would mix step text into the answer.
  "heartbeatSec": 10, // optional; server default ~15, clamped to [5,30]
}
```

Note: `Content-Type` on the _request_ selects prompt-only (`text/plain`) vs
options (`application/json`); the _response_ is always `text/event-stream`. The
old `Accept: text/plain` vs `text/event-stream` switch is gone — verbosity is now
the `doneTextOnly` body option.

## 6. HTTP API — curl-native endpoints, zero client tool

The reachback surface is **three core operations** (`download` / `upload` /
`agent`) plus a `GET skill` bootstrap endpoint (§6c), all under one base URL;
`curl` (or any HTTP client) does everything — there is **no `.mjs` reachback
tool**. Two env
vars carry the base URL and token:

```
HUABU_RFS_URL = http://<host>:<port>/rfs/<canvasId>     # canvasId baked in
Authorization: Bearer ${AGENTLET_TOKEN}                 # daemon-managed (see below)
```

**Env-injection change.** Today Huabu passes only `HUABU_CANVAS_ID` as its
per-spawn app var (`spawn-orchestrator.ts` `reachbackEnv`), while `AGENTLET_SERVER`

- the reachback-dir registry are injected daemon-side and `AGENTLET_TOKEN` is
  inherited through the daemon fork (daemon-owned — not the RFS endpoints' concern).
  This proposal **replaces `HUABU_CANVAS_ID` with `HUABU_RFS_URL`**: the canvas id is
  baked into the base URL, so a separate id var is redundant. Agents that still want
  the bare id parse it from the URL's last segment. (`AGENTLET_TOKEN` auth stays a
  daemon contract — see §7; the endpoints just require a valid bearer.)

| Method + path                   | Op        | Notes                                                                                                                                                                                          |
| ------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET  $RFS/download/<path>`     | download  | `<path>` = ref `filename` (path-only, url-encoded; no listing). Body = content bytes; metadata in `X-Huabu-*` headers.                                                                         |
| `HEAD $RFS/download/<path>`     | stat      | Metadata headers only, no body (cheap probe).                                                                                                                                                  |
| `POST $RFS/upload/<filename>`   | upload    | Body = bytes → stored at `upload/<filename>` (single shared folder). Optional provenance headers (`Author`, …).                                                                                |
| `DELETE $RFS/upload/<filename>` | rm        | Remove a payload from the shared `/upload/` folder.                                                                                                                                            |
| `POST $RFS/agent`               | ask-agent | Prompt in body (`text/plain` = prompt only, or JSON for options). **Response is always `text/event-stream`** (§5). **Sole** canvas mutator **and** the discovery path ("which files matter?"). |

```bash
AUTH="Authorization: Bearer $AGENTLET_TOKEN"
curl -fsS -H "$AUTH" \
  "$HUABU_RFS_URL/download/nodes/Brainstorming%20whiteboard%20diagram.md"      # download by path
curl -fsS -H "$AUTH" -T ./out.md "$HUABU_RFS_URL/upload/out.md"               # upload
curl -N  -H "$AUTH" --data-binary @prompt.md "$HUABU_RFS_URL/agent" \
  | sed -n 's/^data: //p'                                                     # ask agent → clean answer
```

### 6a. Feasibility — these three endpoints fully replace the `.mjs` tool

Every capability of the old reachback tool maps onto plain curl:

| Old tool capability           | curl realization                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `read-node`                   | `GET download/<path>` (metadata in `X-Huabu-*` headers)                                                        |
| `write-node` (+link/notify)   | `POST upload/<file>` → `POST agent` materializes (single-writer)                                               |
| `snapshot` (single / cluster) | two-step: `POST agent` renders to `.artifacts/` → `GET download/artifacts/<key>.png`                           |
| `ask-agent` (+`--show-steps`) | `POST agent` → SSE; `doneTextOnly:true` (default) for clean answer, `false` for step frames                    |
| `--save-session`              | shell redirect `curl … > session.jsonl`                                                                        |
| discovery                     | `POST agent` ("which node files relate to X?") → returns paths                                                 |
| auth                          | `-H "Authorization: Bearer $AGENTLET_TOKEN"` (see mitigation below)                                            |
| error → exit code + message   | `curl -fsS --fail-with-body` (non-zero on HTTP error; `{message}` embeds a runnable `/skill` fetch on 4xx/5xx) |
| prompt-from-file (`@file`)    | `curl --data-binary @prompt.md -H "Content-Type: text/plain" $RFS/agent`                                       |

**What "no tool" moves, not removes.** The interface contract shifts from a
shipped script into: (1) agentlet-injected env (`AGENTLET_TOKEN`,
`HUABU_RFS_URL`), (2) a **skill doc** the agent pulls on demand via
`GET $RFS/skill` (§6c), and (3) a **persona-only system-prompt preamble** whose
only mechanical content is a bootstrap line pointing at that endpoint. This
_removes_ the script build/versioning/distribution burden (the v1 "script
versioning" open issue).

**Auth is a per-request `Authorization: Bearer $AGENTLET_TOKEN` header**, added by
the agent on every call — _not_ a curl-specific `-K` config file. Rationale:
portability. A header works identically across `curl -H`, `wget --header`,
PowerShell `Invoke-WebRequest -Headers`, `python requests`, and Node `fetch`,
whereas `curl -K <rc>` is curl-only and re-introduces the cross-platform coupling
this design avoids (§6b). The agent already has `AGENTLET_TOKEN` in its env, so it
references `$AGENTLET_TOKEN` directly. Trade-off: the expanded token lands in the
process argv (visible in `ps`) — tolerable for trusted first-party agents in phase
1; an env-sourced / rc-file variant is a later hardening option if needed.

**Requirement**: the agent environment must have `curl` (or `wget`/`httpie`).
Acceptable for the target dev-environment coding agents — at least as universal
as the `node` the old `.mjs` tool needed.

### 6b. Cross-platform

The **contract is plain HTTP + Bearer**, which is universal — `curl` is only the
convenient client, so this works on Linux / macOS / Windows and is _broader_ than
the node-only `.mjs` it replaces (an LLM agent can fall back to `curl.exe`,
`Invoke-RestMethod`, `python requests`, Node `fetch`, `wget`). Two platform
gotchas to design around:

- **Windows PowerShell aliases `curl` → `Invoke-WebRequest`** (different flags —
  `-H` fails). Use `curl.exe` explicitly, or bash (git-bash/WSL), or
  `Invoke-RestMethod`. (Windows 10 1803+ ships `curl.exe`.)
- **Shell syntax isn't portable** — env interpolation (`$VAR` / `%VAR%` /
  `$env:VAR`), quoting, and line continuation differ. So a _verbatim_ curl string
  is not universal even where curl exists.

Mitigation: the **skill doc** (§6c) describes the **endpoints** (method · path ·
headers · body) with a curl _example_, not a "run this exact string" script, so
the agent adapts per platform. One caveat — the streaming **`agent`** endpoint
needs a streaming-capable client (`curl.exe -N` or equivalent); avoid
`Invoke-RestMethod`, which buffers the whole response and defeats the keepalive /
timeout-resistance.

### 6c. Skill / prompt delivery — pull, not push

The API mechanics do **not** live in the system prompt. The one-shot preamble is
**persona-only** plus a single bootstrap line, e.g.:

> To work with this Huabu canvas, first fetch the access guide:
> `GET ${HUABU_RFS_URL}/skill` (add header `Authorization: Bearer
${AGENTLET_TOKEN}`). It documents how to read/write files and talk to the
> canvas agent.

The agent pulls the full guide on demand from a new read endpoint:

| Method + path    | Op    | Notes                                                             |
| ---------------- | ----- | ----------------------------------------------------------------- |
| `GET $RFS/skill` | skill | Returns the canvas-access guide as `text/markdown`. Bearer-gated. |

**Server-side resolver** (single source, two-way DRY is _not_ needed here because
there is no push copy): `resolveCanvasSkill(canvasId)` returns the **per-canvas
`skill.md`** at the canvas root if present, else the **bundled default**
`prompt/external-agent/access-huabu.md`. This gives per-canvas customization as a
future extension with zero extra surface.

Why pull:

- **Minimal per-turn tokens** — the preamble stays tiny; the (larger) API guide is
  fetched once when the agent actually needs to act, not prepended every session.
- **Single source of truth** — the endpoint is the only place the guide lives;
  no drift between a pushed copy and a served copy.
- **Self-describing** — mirrors the `skill.md` / `llms.txt` progressive-disclosure
  convention (not an OpenAPI `/docs` spec — this is an LLM-readable usage guide).

Bootstrap is **not** chicken-and-egg: the GET instruction itself is the only
mechanical content pushed in the preamble, and it carries its own auth
(`Authorization: Bearer ${AGENTLET_TOKEN}`), so the very first fetch succeeds.
`/skill` sits under `/api/rfs/`, so it inherits the existing Bearer gate for free.
(Note the naming: canvas-scoped `/api/rfs/:canvasId/skill` is distinct from the
global skill registry at `/api/skills`.)

**Error messages embed a runnable `/skill` fetch (self-healing pull).** Rather
than a non-standard extra field, every `/api/rfs/*` error keeps the repo-standard
`{ "message": … }` shape (per `api-design.md`) and **folds a runnable recovery
command into the message text**, e.g.:

```json
{
  "message": "No node file at 'nodes/foo.md'. To see how to use this canvas, run: curl -sH \"Authorization: Bearer $AGENTLET_TOKEN\" \"$HUABU_RFS_URL/skill\""
}
```

This closes the only real weakness of pull-over-push: an agent that skips the
bootstrap line — or mis-forms a `download` path, a bad `upload`, a malformed
`agent` body — is handed a _copy-pasteable_ command that fetches the full guide,
on its _first_ fumble, instead of flailing. It turns `/skill` from a doc the agent
must remember into a safety net the failure path advertises with a runnable spec,
for ~5 lines of code. (Keep the recovery command out of `2xx` bodies — it's only
useful on `4xx`/`5xx`. The error shape stays plain `{ message }`; no schema
extension.)

### Content vs. metadata — two independent sources

**Content and metadata come from different stores, and the response keeps them
separate:**

- **Content** = the file bytes, returned **as-is**. For `note` / `text` this is
  the stored markdown body (any frontmatter in it is _part of the content_, not
  parsed as metadata); for `web` / `pdf` / `image` / … it is the artifact bytes
  referenced by the node's `src`.
- **Metadata** = the authoritative **node record in `canvas.json` state**
  (`BaseNodeData` + per-type data: `type`, `label`, `labelSource`, position,
  `NodeStyle`, `origin`, `src`, …) — see
  [`packages/shared/src/types/canvas/node.ts`](../../packages/shared/src/types/canvas/node.ts).
  It is **never** derived from the markdown frontmatter.

Two representations, chosen by content negotiation:

1. **(default) raw content + `X-Huabu-*` headers** — body stays pure (matters for
   binary/vision and piping):

   ```
   Content-Type: text/markdown
   X-Huabu-Id: node-123
   X-Huabu-Type: note
   X-Huabu-Label: Login idea
   X-Huabu-Pos: 420,180
   X-Huabu-Attrs: {"style":{...},"origin":{...},"src":null}   # full record as JSON
   ```

2. **`Accept: application/json`** (or `?format=json`) — one structured object:

   ```json
   { "id":"node-123", "type":"note", "label":"Login idea",
     "attributes":{...}, "edges":[{"to":"node-9","dir":"out"}], "content":"..." }
   ```

**Edges appear only in the JSON view** (`Accept: application/json`), never in
`X-Huabu-*` headers: an edge is a relationship _between_ files, not an attribute
_of_ one file, so it belongs to the graph view and is mutated only via
`ask-agent`.

### Auth & safety

Bearer only (no `?token=` query param — avoids leaking tokens in logs/history).
`safeJoin` (`apps/server/src/modules/storage/io.ts`) guards path traversal.
Writes (`POST /upload/…`, `DELETE /upload/…`) are confined to the `/upload/`
folder; everything else under the canvas root is read-only.

`read-node` / `write-node` / `snapshot` HRT verbs and the
`GET /api/reachback/snapshot` endpoint retire. The underlying capabilities
(content read, `execute` command runner, `snapshotNodesToArtifacts`) survive as
**internal-agent tools**, not external verbs.

> Wire contracts (JSON node view, upload response) are defined zod-first in
> `packages/shared/src/types/api/rfs.ts` per
> [`api-design.md`](../architecture/api-design.md). Errors keep the repo-standard
> plain `{ message }` shape (no extra fields); the `/skill` recovery command is
> folded into `message` on 4xx/5xx (§6c). There is **no listing contract** —
> discovery is delegated to `ask-agent`. Binary/stream bodies are exempt from zod
> but their headers/metadata envelopes are typed.

## 7. Open questions

Resolved for phase 1 (kept here as decisions + their guardrails):

- **Read scope → whole-canvas-read**, but limited to `nodes/` + `artifacts/` +
  `upload/`. The `.`-prefixed private dirs (`.memory/` AI-private canvas memory,
  `.history/` chat/events/intent, internal bookkeeping) are **never** exposed.
  Acceptable in phase 1 because **all external agents are first-party, trusted
  agents owned by us** — cross-canvas token scope (below) is a hardening step, not
  a phase-1 blocker.
- **Materialization → strict separation** (two calls: `upload` parks bytes, then
  `agent` creates/places/links). No one-step upload shortcut: the earlier v1
  `--notify` auto-materialization shortcut was **pushed back by maintainers**, so
  the clean data/control split stands. (An `X-Huabu-Hint` one-call variant can be
  reconsidered later only if dogfooding demands it.)
- **`/upload/` GC → internal-agent prompt** ("delete `upload/…` after consuming
  it"), not a coded per-file rule. Best-effort, so keep one cheap backstop (TTL
  sweep or clear-on-canvas-close) to bound accumulation; prompts can't prevent
  two agents choosing the same filename.
- **Internal-agent tool scope → full `operate`.** The internal agent (sole writer)
  runs with the **full canvas toolbelt**, not a forked restricted `reachback` set.
  Rationale: agents are trusted first-party, and a second parallel tool registry is
  cost without payoff at this stage. Content safety lives _inside_ the internal
  agent (its own guard/"sage" logic — e.g. refuse/soft-delete destructive asks),
  not in a truncated tool list. Reachback-originated turns should still be tagged in
  the event log for audit. A hard `reachback` scope is revisited only when opening
  to untrusted agents.

Shipped follow-up:

- **`ask-agent` uses a live internal Deployment.** A first `POST /agent` creates an `operate` Deployment and returns its `threadId` at the start of the SSE stream; a later request supplies `X-Huabu-Thread-Id` and submits a new turn directly to the same live handle. The system prompt is loaded only when the Deployment is created. Continuation is live-only in this phase; durable identity recovery is tracked separately in [#316](https://github.com/hai-team/Huabu/issues/316).

Deferred (default chosen, revisit only if needed):

- **RFS auth = per-request Bearer; token→canvas scoping deferred.** The `/api/rfs/*`
  endpoints authenticate via `Authorization: Bearer $AGENTLET_TOKEN` on every
  request, validated by the existing `app.ts` gate against the **per-daemon** token
  (`getDaemonAuth().getToken()`). The agent has that token in its env (inherited
  through the daemon fork). Because the token is per-daemon — not per-canvas — and
  `canvasId` sits in the URL, nothing inherently stops a token from reaching
  _another_ canvas by editing the URL. Tolerable in phase 1 (trusted first-party
  agents); **must** be closed before third-party / untrusted agents: bind each token
  to its allowed canvas set (or mint a canvas-scoped token at spawn). (This is an
  agentlet/daemon-side change, not an RFS-endpoint change.)
- **Path stability** — `filename` is label-based, so a rename / dedupe changes a
  node's path and a cached path can 404. Tolerable under single-writer +
  read-only: on a 404 the agent asks `ask-agent` for the current path, or uses the
  fresh `filename` from the next turn's refs.
- **Token in process argv** — per-request `Authorization: Bearer $AGENTLET_TOKEN`
  puts the expanded token in the command line (visible in `ps`). Accepted in phase
  1 for portability (a header works across curl / wget / PowerShell / requests,
  unlike curl-only `-K rc`); an env-sourced or rc-file variant is a later hardening
  option.

## 8. Migration from v1

1. Add the RFS endpoints — `GET download`, `POST`/`DELETE upload`, `POST agent`,
   and `GET skill` (§6c) — under `/api/rfs/:canvasId`, and inject `HUABU_RFS_URL`
   in place of `HUABU_CANVAS_ID` (`spawn-orchestrator.ts` `reachbackEnv`).
2. Move `read-node` / `write-node` / `snapshot` capabilities into internal-agent
   tools. Refactor the external-agent prompt: `system_prompt.md` becomes
   **persona-only + a bootstrap line** pointing at `GET ${HUABU_RFS_URL}/skill`;
   the API mechanics move into a bundled `access-huabu.md` served by that endpoint
   (per-canvas `skill.md` override → default `access-huabu.md`). No pushed copy.
3. Remove the `read-node` / `write-node` / `snapshot` HRT verbs, the
   `GET /api/reachback/snapshot` endpoint, **and the `.mjs` reachback tool + its
   `server/sendResource` distribution** (obsoletes the v1 "script versioning"
   issue).
4. Fold the shipped design into [`agent-reachback.md`](../architecture/agent-reachback.md), mark this proposal `Shipped`, and retain its stable path for design history.
