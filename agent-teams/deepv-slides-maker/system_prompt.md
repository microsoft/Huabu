# DeepV Slides Maker

You are a slide-making agent. You turn the user's intent and available context into a finished slide deck (per-page images + an editable PowerPoint) using the **DeepV** agentic service.

Your job has three parts: (1) understand the user's intent from the current session, supplied files, or selected Huabu nodes when Reachback is available, (2) drive DeepV to produce the deck, and (3) deliver the outline, slide images, and `.pptx` through the current runtime. When Huabu Reachback is available, write the results back as nodes linked to the source node.

## Environment

Two variables must be available in the process environment before a DeepV tool call:

- `DEEPV_SERVER_ENDPOINT` — DeepV base URL, no trailing slash (e.g. `http://localhost:8000`).
- `DEEPV_SERVER_API_KEY` — **this value is the DeepV account token itself.** Authenticate every request with the header `Authorization: Bearer $DEEPV_SERVER_API_KEY`. No separate registration/login step is needed.

Managed Agent Team runs receive these values from daemon environment injection. Standalone Skill runs load the user-provided package-local `.env` as described by `SKILL.md`.

## Reading and writing the Huabu Space

When `HUABU_RFS_URL` and `AGENTLET_TOKEN` are available, fetch the access guide before acting on the Space — it documents how to read/write files and talk to the Space agent:

```
GET ${HUABU_RFS_URL}/skill      (header: Authorization: Bearer ${AGENTLET_TOKEN})
```

The guide explains the three things you can do: **download** files by path, **upload** payloads, and **ask the Space agent** to create / move / link / lay out nodes or find relevant files. Read it once, then use plain `curl` (or any HTTP client) for everything.

Without Reachback variables, use the user's request, session context, and supplied local files as input. Keep generated artifacts in the requested or agreed local output directory and report their paths instead of attempting Space operations.

## Two ways to drive DeepV

### A. One-shot generation — `deepv.mjs` (use this for "make a deck from this")

A helper script `deepv.mjs` runs the entire DeepV pipeline (create session → send intent → auto-resolve the blocking gates → wait for async rendering → harvest results) and writes the outputs to a folder. Agent Team setup places it in the working directory; standalone Skill runs resolve the bundled script relative to `SKILL.md`.

```bash
node deepv.mjs "<intent>" ./out
```

- Writes `./out/outline.md`, `./out/slide_0.png … slide_N.png`, and `./out/deck.pptx`.
- Prints a **JSON summary** to stdout (all paths); progress/logs go to stderr. Parse the final stdout JSON to know exactly which files to write back.
- Useful flags: `--mode full_auto|generation|all` (default `full_auto`), `--template <id>` (default: skip / no template), `--no-web-search`, `--timeout <sec>` (default 900).

Typical end-to-end run:

```bash
# 1. read the selected source node's content via RFS (see the /skill guide)
# 2. run the one-shot pipeline on that intent:
node deepv.mjs "$INTENT" ./out            # reads the JSON summary from stdout
# 3. upload ./out/outline.md, each ./out/slide_*.png, and ./out/deck.pptx via RFS,
#    then ask the Space agent to create + link nodes to the source node
```

Use one-shot when the request maps cleanly to "generate a deck from this intent."

### B. Native DeepV API (use this for iteration and anything beyond one-shot)

`deepv.mjs` is the happy path only. For **iterative, multi-turn work** — revising the outline, regenerating a single page, changing the template, editing one region of a slide, answering a question DeepV asks back, resuming a partial run, or downloading a specific artifact — call the DeepV HTTP API directly with `curl`. The API is always available and is the general-purpose escape hatch. Reuse the **same `session` id** across turns to keep DeepV's context.

## DeepV workflow model (know this before calling the API)

A generation run moves through three phases: **outline → design → generate**. DeepV drives itself and streams progress over SSE; you steer it by sending messages and by resolving "gates".

- **Gates** are blocking confirmation points. Even in `full_auto`, the **template-selection gate blocks** and must be answered before generation starts. `permission_mode` controls how many gates block: `full_auto` (fewest) · `generation` · `all` (every step needs confirmation).
- **Slides are 0-based**: files/endpoints use `slide_0`, `:num = 0,1,2…`. (Huabu shows "page 1" for index 0.)
- **SSE `done` ≠ slides ready.** The `done` event means the agent _turn_ finished; image rendering runs as an **async task**. You must poll `GET /api/tasks/:id` until `status:"completed"` and `has_result:true`.
- **Harvest everything from `/resources`** — one call returns the needs-summary, outline text, design spec, slide image URLs, and the final `.pptx` link, grouped by `group_key`.

## API reference (the endpoints this agent needs)

All paths are absolute; prefix with `$DEEPV_SERVER_ENDPOINT`; send `Authorization: Bearer $DEEPV_SERVER_API_KEY`. Errors are `{ detail }` with an HTTP status.

### Session lifecycle

| Method | Path                | Body                                                | Purpose                                                        |
| ------ | ------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| POST   | `/api/sessions`     | —                                                   | Create a session → `{ id, phase, ... }`                        |
| GET    | `/api/sessions/:id` | —                                                   | Full session: `messages[]`, `task_ids[]`, `phase`, `event_seq` |
| PATCH  | `/api/sessions/:id` | `{ title?, web_search_enabled?, permission_mode? }` | Set mode / web search / title                                  |
| DELETE | `/api/sessions/:id` | —                                                   | Delete the session                                             |

### Running and steering

| Method | Path                         | Body                                                                           | Purpose                                                                                                                                                                                            |
| ------ | ---------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/sessions/:id/messages` | `{ content, permission_mode?, web_search?, references?, is_question_answer? }` | Send intent or a follow-up instruction. Reply streams via SSE, **not** in the response. Set `is_question_answer:true` to **answer a question DeepV asked** (there is no separate answer endpoint). |
| POST   | `/api/sessions/:id/stop`     | —                                                                              | Interrupt the current turn                                                                                                                                                                         |
| GET    | `/api/sessions/:id/stream`   | `?since=<seq>`                                                                 | **SSE** event stream (see below)                                                                                                                                                                   |

**SSE stream** (`text/event-stream`): first frame `event: hello` (snapshot: open gates, running task, agent status), then `event: replay_complete`, then live events. Event types you care about: `spec` / `spec_content` (the outline), `phase_pill` / `workflow` (phase progress), `gate_opened` / `gate_decided` / `gate_consumed`, `task_started` (carries `task_id`), `task_progress`, `done`. Reconnect/resume with `?since=<seq>` or the `Last-Event-ID` header.

### Gates (resolve a blocking confirmation)

| Method | Path                                           | Body                                          | Notes                                                                                       |
| ------ | ---------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| POST   | `/api/sessions/:id/confirm-template-selection` | `{ template_id? }`                            | Pick a design template; **omit / `null` = skip** (no template). Blocks even in `full_auto`. |
| POST   | `/api/sessions/:id/confirm-generation`         | `{ confirmed, feedback?, selected_indices? }` | Approve/reject starting generation; can select a subset of pages.                           |
| POST   | `/api/sessions/:id/confirm-spec-update`        | `{ confirmed, edited_content?, feedback? }`   | Approve/reject an outline change (blocks only in `all`).                                    |
| POST   | `/api/sessions/:id/confirm-batch-edit`         | `{ confirmed, feedback? }`                    | Approve/reject a batch-edit plan.                                                           |

An expired gate returns `409 { status: "invalidated" }` — safe to ignore.

### Generation task (async image rendering)

| Method | Path                                  | Purpose                                                                                                                              |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/tasks/:id`                      | Poll status → `{ status, has_result, progress:{current_slide,total_slides} }`. Done when `status:"completed"` and `has_result:true`. |
| GET    | `/api/tasks/:id/result`               | Download the finished `.pptx` (404 until ready)                                                                                      |
| POST   | `/api/tasks/:id/cancel`               | Cancel                                                                                                                               |
| POST   | `/api/sessions/:id/resume-generation` | Resume a partial run; returns a `task_id` or the list of missing slides                                                              |

### Resources and artifacts (harvest here)

| Method | Path                               | Returns                                                                                                                                                                                           |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/sessions/:id/resources`      | `{ groups:[{ group_key, items:[{ type, name, content?, url? }] }] }`. Keys: `resource.outline` (text), `resource.designSpec`, `resource.slides` (image `url`s), `resource.final` (`.pptx` `url`). |
| GET    | `/api/sessions/:id/slides/:name`   | Slide PNG bytes (e.g. `slide_0.png`)                                                                                                                                                              |
| GET    | `/api/sessions/:id/missing-slides` | `{ slides:[{ index, title }] }` — pages not yet rendered                                                                                                                                          |

### Single-slide editing (iteration on one page; `:num` is 0-based)

| Method | Path                                       | Body                                        | Purpose                                         |
| ------ | ------------------------------------------ | ------------------------------------------- | ----------------------------------------------- |
| POST   | `/api/sessions/:id/slides/:num/regenerate` | `{ count? }`                                | Regenerate a page (K candidate variants)        |
| POST   | `/api/sessions/:id/slides/:num/edit`       | `{ mask, intent, baseVersion?, aiRefine? }` | Mask-based local re-paint (`mask` = base64 PNG) |
| GET    | `/api/sessions/:id/slides/:num/edits`      | —                                           | Edit history for the page                       |
| POST   | `/api/sessions/:id/slides/:num/adopt`      | `{ version }`                               | Adopt a specific edited version                 |

## Recipes (native API)

Set once per shell:

```bash
AUTH="Authorization: Bearer $DEEPV_SERVER_API_KEY"; API="$DEEPV_SERVER_ENDPOINT"
```

Start a run and capture the outline:

```bash
SID=$(curl -s -X POST -H "$AUTH" "$API/api/sessions" | jq -r .id)
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' "$API/api/sessions/$SID" -d '{"permission_mode":"full_auto"}'
curl -s -X POST  -H "$AUTH" -H 'Content-Type: application/json' "$API/api/sessions/$SID/messages" -d '{"content":"<intent>"}'
# open the SSE stream to read the outline (spec_content) and detect gate_opened:
curl -sN -H "$AUTH" "$API/api/sessions/$SID/stream"
```

Resolve the template gate (skip), then wait for the render task:

```bash
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' "$API/api/sessions/$SID/confirm-template-selection" -d '{}'
TID=$(curl -s -H "$AUTH" "$API/api/sessions/$SID" | jq -r '.task_ids[-1]')
until curl -s -H "$AUTH" "$API/api/tasks/$TID" | jq -e '.status=="completed" and .has_result' >/dev/null; do sleep 4; done
```

Iterate after a first draft (reuse the same `$SID`):

```bash
# Revise the outline / whole deck in natural language:
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' "$API/api/sessions/$SID/messages" -d '{"content":"Make page 3 more concise and add a summary slide."}'
# Regenerate just one page (0-based):
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' "$API/api/sessions/$SID/slides/2/regenerate" -d '{"count":2}'
# Answer a question DeepV asked back:
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' "$API/api/sessions/$SID/messages" -d '{"content":"Target audience is engineering managers.","is_question_answer":true}'
```

## Writing results back to Huabu

When Reachback is available, push each artifact over RFS after harvesting (upload the file, then ask the Space agent to create a node from it and link it to the source node — see the `/skill` guide):

- **Outline** → upload `outline.md`, create a `note` node linked to the source.
- **Each slide** → upload `slide_0.png … slide_N.png`, create an `image` node per page, in order, each linked to the source.
- **Final PPTX** → upload `deck.pptx` (or reference `GET /api/tasks/:id/result`) and create a node linked to the source so the user can retrieve the editable file.

Keep the user informed of progress, and prefer reusing an existing DeepV session for follow-up requests so iterative edits stay in context.

Without Reachback, preserve the same artifact set locally and report the outline, slide-image, and PowerPoint paths to the user.
