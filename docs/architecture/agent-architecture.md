# Agent Architecture

> Runtime architecture of the server-side agent: runtime, entry points, tools,
> skills, external agents, persistence.
> Last updated: 2026-07-10

Module root: [apps/server/src/modules/agent](../../apps/server/src/modules/agent) · prompt root: [apps/server/src/prompt](../../apps/server/src/prompt)

---

## 1. Runtime

The server-side agent loop runs on the `Agent` class from
`@earendil-works/pi-agent-core`, wrapped in the `runAgent()` async generator in
[agent.service.ts](../../apps/server/src/modules/agent/agent.service.ts).

Key runtime characteristics:

- **Parallel tools**: `toolExecution: 'parallel'` dispatches concurrently by
  default; `canvas_commands` / `fs_write` / `generate_image` carry
  `executionMode: 'sequential'` on their def and degrade to serial execution
  (avoiding server-side races + SSE completion-order races).
- **`maxIterations` soft cap**: the service counts `turn_end`; on overflow it
  calls `agent.abort()` and appends a cap-out notice. Each agent declares
  `runtime.maxIterations` in its AGENT.md frontmatter (default 20, sketch=6).
- **`getApiKey: () => ensureApiKey()`**: the OAuth token can be refreshed during
  long-running tools ([llm.ts](../../apps/server/src/modules/agent/llm.ts) /
  [oauth.ts](../../apps/server/src/modules/agent/oauth.ts)).
- **Abort**: route `signal` → `agent.abort()`; pi-agent-core writes a final
  message with `stopReason: 'aborted'`.

---

## 2. Entry points & agents

Five built-in agents, each with a
[prompt/agents/<id>/AGENT.md](../../apps/server/src/prompt/agents) (frontmatter
declares `tools` / `skillScope` / `runtime`; loader in
[agents/loader.ts](../../apps/server/src/prompt/agents/loader.ts)):

| Agent             | Entry point                                                                                                                                         | Notes                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ask` / `operate` | `POST /api/agent` ([agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts) → `runAgent`)                                               | Main chat path; ask is read-only, operate can write. Question nodes also go through here.                                         |
| `sketch`          | [sketch.service.ts](../../apps/server/src/modules/agent/sketch.service.ts) `recognizeSketchCommands()`                                              | Gesture → `CanvasCommand[]`; same `runAgent` but with `sketch` scope + `sketch-recognized` origin, drains the generator (no SSE). |
| `intent`          | [intent.route.ts](../../apps/server/src/modules/agent/intent.route.ts) → [intent.service.ts](../../apps/server/src/modules/agent/intent.service.ts) | A single LLM call that ranks candidates, `tools: []`, no agent loop.                                                              |
| `memory`          | [memory/](../../apps/server/src/modules/agent/memory) background curator                                                                            | Triggered by the op-counter; see [agent-memory.md](./agent-memory.md).                                                            |

**External / ACP agents**: when a chat request carries a `binding` field it routes through [acp/](../../apps/server/src/modules/agent/acp) (§6) instead of the built-in `runAgent`.

---

## 3. SSE protocol

The server emits only its custom
[`AgentStreamEvent`](../../packages/shared/src/types/agent/agent.ts) (14 types:
`meta` / `text_delta` / `thinking_delta` / `tool_call` / `tool_call_update` /
`plan` / `permission_request` / `config_options_update` / `session_mode_update`
/ `session_info_update` / `session_usage_update` / `done` / `error` / `end`);
the frontend [useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts) has
no awareness of pi-agent-core.

Internal pi-ai tools and external ACP share the same `tool_call` envelope:
internal turns carry `internalToolName` on `tool_call` to drive the frontend
render variant + local side effects (e.g. executing `canvas_commands`); ACP
turns omit that field and render as `generic`.

---

## 4. Tools

File organization:

```
tools/
  definitions.ts   ← TOOL_REGISTRY: pure schema + description (pure)
  index.ts         ← buildToolsForScope / buildAgentToolsByNames (resolve by name)
  executor.ts      ← executeTool(name, args, ctx) → handler dispatch, injects canvasId
  schemas/         ← TypeBox command / node / edge atomic schemas
  handlers/        ← individual tool implementations
```

12 tools, assigned via each agent frontmatter's `tools` array (**not** a
hardcoded list in code):

| Tool                                                     | Handler                                                                                       | Scope                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `get_canvas_outline` / `inspect_nodes` / `inspect_edges` | [canvas-query.ts](../../apps/server/src/modules/agent/tools/handlers/canvas-query.ts)         | ask/operate/sketch                            |
| `read`                                                   | [fs-read.ts](../../apps/server/src/modules/agent/tools/handlers/fs-read.ts)                   | ask/operate/sketch/memory                     |
| `grep` / `find` / `ls`                                   | [fs-search.ts](../../apps/server/src/modules/agent/tools/handlers/fs-search.ts)               | ask/operate/sketch                            |
| `web_search`                                             | [web-search.ts](../../apps/server/src/modules/agent/tools/handlers/web-search.ts)             | ask/operate                                   |
| `canvas_commands`                                        | [canvas-write.ts](../../apps/server/src/modules/agent/tools/handlers/canvas-write.ts)         | operate/sketch                                |
| `fs_write`                                               | [fs-write.ts](../../apps/server/src/modules/agent/tools/handlers/fs-write.ts)                 | operate/memory                                |
| `snapshot_nodes`                                         | [snapshot-node.ts](../../apps/server/src/modules/agent/tools/handlers/snapshot-node.ts)       | operate (+ auto snapshot on the sketch route) |
| `generate_image`                                         | [image-generation.ts](../../apps/server/src/modules/agent/tools/handlers/image-generation.ts) | operate                                       |

Design principles:

1. **Don't reinvent what's readable on disk**: node text (label/content/summary/...)
   goes through `read("nodes/<id>.md")`; spatial fields through `inspect_nodes`;
   edge visuals through `inspect_edges`; the outline carries topology only.
2. **Canvas isolation**: `safeResolve(canvasId, path)` does strict prefix
   validation rooted at the canvas directory — no cross-canvas access
   ([fs-sandbox.ts](../../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts)).
3. **Error protocol**: handlers `throw` on failure, pi-agent-core wraps it as
   `isError: true`; never encode an error into success JSON.
4. **Truncation contract**: read tools return `count + truncated`, and add
   `total` only when the full set is cheap to obtain.

`canvas_commands` covers 13 commands
([schemas/command.ts](../../apps/server/src/modules/agent/tools/schemas/command.ts)):
CREATE_NODES, DELETE_NODES, MERGE_NODE_DATA, SET_NODE_PARENT, DISSOLVE_FRAME,
SET_NODE_GEOMETRY, REORDER_NODES, CONNECT_NODES, DISCONNECT_EDGES,
SET_EDGE_STYLE, ALIGN_NODES, DISTRIBUTE_NODES,
SET_FRAME_LAYOUT — the agent subset of
[`CanvasCommand`](../../packages/shared/src/types/canvas/command.ts) (excluding
the UI-only `SET_NODE_LOCKED / SET_NODE_SELECTION / CHANGE_NODE_TYPE`). Commands
execute server-side, persist to disk, and return deltas; see
[canvas-command-architecture.md](./canvas-command-architecture.md).

---

## 5. Context & persistence

Chat context is assembled with an **envelope-first** model (see
[agent-context.md](./agent-context.md)):

- [conversation/](../../apps/server/src/modules/agent/conversation) renders each
  turn into a `ChatEnvelope` (user text + selection + anchor + skills), then
  serializes it into pi-ai messages.
- Persistence lives in
  [store/chat-thread-store.ts](../../apps/server/src/modules/agent/store/chat-thread-store.ts):
  `<canvasDir>/.history/chat/<threadId>.turns.jsonl` (append-only completed
  turns) + `.active.json` (in-progress). Each turn records
  `{ envelope, transcript, acp? }`; the envelope is the single source of truth —
  the user message is not persisted separately and is rebuilt from the envelope
  on reload (`rebuildContextMessages`).
- Intent episodes are recorded in
  [store/intent-store.ts](../../apps/server/src/modules/agent/store/intent-store.ts).

---

## 6. External agents (ACP)

[acp/](../../apps/server/src/modules/agent/acp) is the integration layer for external agents. Its trusted built-in catalogue detects and launches GitHub Copilot, Claude Agent, Gemini, Codex, Qwen Code, Kimi Code CLI, OpenCode, and Cursor; custom commands remain available for other ACP-compatible agents.

- [service.ts](../../apps/server/src/modules/agent/acp/service.ts) `runAcpAgent()` — the
  counterpart of `runAgent`, talking to an external daemon
- [preprocessor.ts](../../apps/server/src/modules/agent/acp/preprocessor.ts) — serializes
  the `ChatEnvelope` into the external wire payload (internal & external share the
  same envelope)
- [translator.ts](../../apps/server/src/modules/agent/acp/translator.ts) — ACP update →
  `AgentStreamEvent`
- [session-registry.ts](../../apps/server/src/modules/agent/acp/session-registry.ts) /
  [session-store.ts](../../apps/server/src/modules/agent/acp/session-store.ts) — one ACP
  session per Sediment thread
- [profile-store.ts](../../apps/server/src/modules/agent/acp/profile-store.ts) /
  [spawn-orchestrator.ts](../../apps/server/src/modules/agent/acp/spawn-orchestrator.ts) /
  daemon routes — agent configuration + daemon lifecycle

External agents can read/write the canvas through the **reachback** channel (see
[agent-reachback.md](./agent-reachback.md)). The connection / protocol internals
are mid-refactor; see
[acp-eventstore-refactor-plan.md](../proposals/acp-eventstore-refactor-plan.md)
and [agentlet-upgrade-plan.md](../proposals/agentlet-upgrade-plan.md).

---

## 7. Skills

Skills are **not tools**; they enter the prompt via two paths — catalogue
(on-demand) + invoked (explicit `/cmd`); see
[agent-context.md §3.2](./agent-context.md).

```
prompt/skills/
  loader.ts      ← loadSkill / mergeSkill: merges system + user sources, mtime cache
  catalogue.ts   ← getSkillCatalogue(scope) renders the listing in the system prompt
  canvas/        ← core canvas skill (commands + references + layout recipes)
  sketch-gestures/  ← sketch gesture recognition
  create-skill/ · update-skill/  ← skill authoring guides
  memory/        ← memory-writing strategy sub-doc (see agent-memory.md)
```

- System skills live in `prompt/skills/<id>/` (shipped with the program); user
  skills live in `<workspace>/setting/skills/<id>/`, merged by matching id.
- Frontmatter requires `id / name / description / appliesTo`
  (`∈ {ask,operate,sketch,external}`); optional `triggers / version /
userInvokable`.
- The catalogue is filtered by each agent's `skillScope`; the agent self-serves
  the body via `read("skills/<id>/SKILL.md")`. The `use_skill` tool has been
  retired.
- Which items the `/` menu can invoke is decided by `isUserInvokableSkill()` in
  [skills.route.ts](../../apps/server/src/modules/agent/skills.route.ts).

---

## 8. Checklist for changing / adding a tool or skill

To add / change a tool:

1. Add the schema in `tools/schemas/` (skip if reusing existing atoms).
2. Add the def in `tools/definitions.ts` (schema + description + boundary
   notes), register it in `TOOL_REGISTRY`.
3. Put the body in `tools/handlers/<name>.ts`; `throw` on failure.
4. Add a `case` in `tools/executor.ts`, `withCanvasId(...)` as needed.
5. Add the name to the `tools` array of every `agents/<id>/AGENT.md` that uses it.

To add / change a skill:

1. `prompt/skills/<id>/SKILL.md`, with the four required frontmatter fields.
2. Split long content into `references/*.md`, linked from SKILL.md via
   `read("skills/<id>/references/<file>.md")`.
3. Confirm at startup that the loader reports no errors; the catalogue appears
   automatically in the matching scope.

---

## Related docs

- [agent-context.md](./agent-context.md) — how context is assembled into the
  prompt (envelope / selection / skill injection).
- [agent-memory.md](./agent-memory.md) — the three-layer memory and background
  curator.
- [canvas-command-architecture.md](./canvas-command-architecture.md) — the
  three-layer model of `canvas_commands` and server-side execution.
- [sketch-node.md](./sketch-node.md) — sketch nodes and the recognition pipeline.
- [agent-reachback.md](./agent-reachback.md) — the reachback channel external
  agents use to read/write the canvas.
