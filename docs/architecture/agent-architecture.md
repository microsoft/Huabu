# Agent Architecture

> Runtime architecture of the server-side agent: runtime, entry points, tools, skills, external agents, persistence.
> Last updated: 2026-07-18

Module root: [apps/server/src/modules/agent](../../apps/server/src/modules/agent) · prompt root: [apps/server/src/prompt](../../apps/server/src/prompt)

---

## 1. Runtime

The server-side built-in agent loop runs through the standard [`@agenetes/pi-driver`](../../external/agenetes/packages/pi-driver), which wraps one `@earendil-works/pi-agent-core` `Agent` behind the shared `AgentHandle` contract. The host-side [runAgent()](../../apps/server/src/modules/agent/agent.service.ts) generator is the Huabu adapter layer: it renders a `ChatEnvelope` into canonical `AgentInput[]`, constructs an `AgentSubmission<ChatEnvelope>`, compiles the loaded AGENT.md profile into a serializable `PiWorkloadSpec`, injects model/account/tool ports, and forwards yielded `AgentStreamEvent`s to the route and internal callers.

Key runtime characteristics:

- **Parallel tools**: `toolExecution: 'parallel'` dispatches concurrently by
  default; `space_commands` / `fs_write` / `generate_image` carry
  `executionMode: 'sequential'` on their def and degrade to serial execution
  (avoiding server-side races + SSE completion-order races).
- **`maxIterations` soft cap**: the service counts `turn_end`; on overflow it
  calls `agent.abort()` and appends a cap-out notice. Each agent declares
  `runtime.maxIterations` in its AGENT.md frontmatter (default 20, sketch=6).
- **`getApiKey: () => ensureApiKey()`**: the OAuth token can be refreshed during
  long-running tools ([llm.ts](../../apps/server/src/modules/agent/llm.ts) /
  [oauth.ts](../../apps/server/src/modules/agent/oauth.ts)).
- **Built-in chat is a Deployment**: `POST /api/agent` reuses one live `PiAgentHandle` per `threadId` (get-or-create by Agenetes). On restart, Agenetes supplies durable materialized history through `AgentCreateContext`; that history contains completed Tier-2 turns plus an optional read-time incomplete turn projected from the Tier-1 `turn_start` and event suffix. pi-driver lowers that history through its `materializeHistory` port and seeds the result through pi-agent-core's native `initialState.messages`. Huabu implements the port in [history-replay.ts](../../apps/server/src/modules/agent/agenetes/history-replay.ts) on top of `rebuildTurnMessages`, whose job is to restore the context the live handle would still be holding: each turn replays the canonical `rendered` input array persisted with its submission, so role attribution, `toolCall`/`toolResult` pairing, and images as real vision parts all come back byte-identical to what the model saw. The folded transcript is projected one round at a time, so a multi-round turn replays as `assistant → toolResult → assistant` instead of collapsing into a single block, and a tool call folded with `status: 'failed'` replays as an error result. Only records written before `rendered` existed fall back to re-rendering the stored envelope, and that path drops the neighbourhood, whose point-in-time snapshot would otherwise differ on every rebuild and break the provider's prefix cache. Replay deliberately does not trim: context growth belongs to the conversation, and budgeting only on recovery would make a recovered thread quietly forget what a never-restarted one remembers. Because the payload is not the durable record, the driver reports the materialized `estimatedSize` to `authorizeHistoryLoad`; the mounted `AutoRecoverPolicy` limit is `HISTORY_LOAD_SANITY_LIMIT`, a corruption guard sitting far above any genuine conversation, not a context budget. The route no longer rebuilds transcript context or persists turns. The workload's `initialPreamble` is mapped to pi-agent-core's native `systemPrompt`; later prompt changes use native `set_context`. The pi driver also re-resolves the symbolic `{ type: 'host', id: 'active' }` model ref at every turn boundary.
- **RFS agent conversations are live Deployments**: the first `POST /api/rfs/:canvasId/agent` request creates an internal `operate` Deployment, supplies its system prompt once through `initialPreamble`, submits the raw request as the first canonical turn, and returns the `threadId` at stream start. A later request with `X-Huabu-Thread-Id` validates the canvas-scoped durable record and submits directly to the existing live handle without reloading the profile, rebuilding the spec, or updating the system prompt. A missing live handle returns `409 thread_not_live`; automatic identity recovery is tracked in [#316](https://github.com/hai-team/Sediment/issues/316).
- **Deployment turns are mutually exclusive**: `/api/agent` and RFS acquire one shared per-`threadId` turn lease before starting SSE. The lease remains held until the run settles, including when `/api/agent` continues in the background after a client disconnect.
- **Abort**: route `signal` → `agent.abort()`; pi-agent-core writes a final message with `stopReason: 'aborted'`. ACP turns check the same signal both before and after session bootstrap, so stopping during process startup never dispatches the pending `session/prompt`. A replacement `/api/agent` request waits (bounded) for any in-flight turn on the same thread to release its lease before acquiring — this absorbs the cancel-then-resend race where the client's fire-and-forget `/stop` has not yet reached the server. A turn that never releases within the timeout, or a genuinely concurrent turn, still receives `409 thread_busy`.
- **Headless source conversations**: the visible Canvas does not determine execution ownership. A World `nodeRef` presentation routes history, reconnect, `/api/agent`, tools, and change records through the source question's Canvas/thread and uses the source question as `anchorNodeId`. Lifecycle patches use the existing server Canvas executor against that owner, so the active World store never authors source status.

---

## 2. Entry points & agents

Five built-in agents, each with a
[prompt/agents/<id>/AGENT.md](../../apps/server/src/prompt/agents) (frontmatter
declares `tools` / `skillScope` / `runtime`; loader in
[agents/loader.ts](../../apps/server/src/prompt/agents/loader.ts)):

| Agent             | Entry point                                                                                                                                         | Notes                                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask` / `operate` | `POST /api/agent` ([agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts) → `runAgent`)                                               | Main chat path; ask is read-only, operate can write. This path now uses a built-in **Deployment** handle (one live pi session per `threadId`). Question nodes also go through here. |
| `sketch`          | [sketch.service.ts](../../apps/server/src/modules/agent/sketch.service.ts) `recognizeSketchCommands()`                                              | Gesture → `CanvasCommand[]`; same `runAgent` but with `sketch` scope + `sketch-recognized` origin, drains the generator (no SSE).                                                   |
| `intent`          | [intent.route.ts](../../apps/server/src/modules/agent/intent.route.ts) → [intent.service.ts](../../apps/server/src/modules/agent/intent.service.ts) | A single LLM call that ranks candidates, `tools: []`, no agent loop.                                                                                                                |
| `memory`          | [memory/](../../apps/server/src/modules/agent/memory) background curator                                                                            | Triggered by the op-counter; see [agent-memory.md](./agent-memory.md).                                                                                                              |

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

Internal pi-ai tools and external ACP share the same `tool_call` envelope. On the live stream, the Huabu host adds `internalToolName` to internal turns to drive frontend render variants and local side effects (e.g. executing `space_commands`); ACP turns omit it and render as `generic`. Folded pi-driver history keeps the exact tool name in `title`; the history route recovers internal render variants from that field only when the persisted workload kind is `internal`, so an external tool with the same title remains generic.

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

| Tool                                                    | Handler                                                                                       | Scope                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `get_space_outline` / `inspect_nodes` / `inspect_edges` | [canvas-query.ts](../../apps/server/src/modules/agent/tools/handlers/canvas-query.ts)         | ask/operate/sketch                            |
| `read`                                                  | [fs-read.ts](../../apps/server/src/modules/agent/tools/handlers/fs-read.ts)                   | ask/operate/sketch/memory                     |
| `grep` / `find` / `ls`                                  | [fs-search.ts](../../apps/server/src/modules/agent/tools/handlers/fs-search.ts)               | ask/operate/sketch                            |
| `web_search`                                            | [web-search.ts](../../apps/server/src/modules/agent/tools/handlers/web-search.ts)             | ask/operate                                   |
| `space_commands`                                        | [canvas-write.ts](../../apps/server/src/modules/agent/tools/handlers/canvas-write.ts)         | operate/sketch                                |
| `fs_write`                                              | [fs-write.ts](../../apps/server/src/modules/agent/tools/handlers/fs-write.ts)                 | operate/memory                                |
| `snapshot_nodes`                                        | [snapshot-node.ts](../../apps/server/src/modules/agent/tools/handlers/snapshot-node.ts)       | operate (+ auto snapshot on the sketch route) |
| `generate_image`                                        | [image-generation.ts](../../apps/server/src/modules/agent/tools/handlers/image-generation.ts) | operate                                       |

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
5. **World target reads**: read-only built-in tools remain implicitly scoped by default. A World-owned conversation may pass `targetCanvasId` from a `canvasRef` returned by the World outline; the executor accepts it only when exactly one canonical Portal addresses that Canvas. Ordinary Space conversations cannot opt into another Canvas, and write or artifact-materializing tools never consume this field. `snapshot_nodes` remains owner-scoped; source images can be viewed inline through targeted `read`.

`space_commands` covers 14 commands ([space-operations.ts](../../packages/shared/src/types/api/space-operations.ts)): CREATE_NODES, DELETE_NODES, MERGE_NODE_DATA, SET_NODE_PARENT, DISSOLVE_FRAME, SET_NODE_GEOMETRY, REORDER_NODES, CONNECT_NODES, DISCONNECT_EDGES, SET_EDGE_STYLE, ALIGN_NODES, DISTRIBUTE_NODES, SET_FRAME_LAYOUT, SET_PORTAL_NODE_PINS — the agent subset of [`CanvasCommand`](../../packages/shared/src/types/canvas/command.ts) (excluding the UI-only `SET_NODE_LOCKED / SET_NODE_SELECTION / CHANGE_NODE_TYPE`). Portal Pin commands route to the workspace World and never mutate their source Space. The canonical Zod contracts are converted to the JSON Schema shape expected by pi-ai in [zod-tool-schema.ts](../../apps/server/src/modules/agent/tools/zod-tool-schema.ts). Commands execute server-side, persist to disk, and return deltas; see [canvas-command-architecture.md](./canvas-command-architecture.md).

---

## 5. Context & persistence

Chat context uses an **envelope-first submission boundary** (see [agent-context.md](./agent-context.md)):

- [conversation/](../../apps/server/src/modules/agent/conversation) builds each turn's `ChatEnvelope` (user text + selection + anchor + skills). Before calling an agent handle, the selected host adapter renders that envelope into ordered canonical `AgentInput[]` and constructs `{ type: 'huabu.chat', content: envelope, rendered }`.
- `AgentHandle.run(submission, ctx)` receives only data and live turn context; no host render closure crosses into Agenetes. One submission always remains one backend turn. pi preserves multiple canonical members through one atomic `agent.prompt(Message[])`; ACP flattens them in order into one `session/prompt`.
- Agenetes owns conversation persistence per `(namespace, threadId)`: Tier 1 stores the complete submission plus streamed events, and Tier 2 stores the folded completed `AgentTurn`. The historical field remains named `request` for log compatibility but now carries the complete submission. Each driver decides how to lower that record back into its own channel: the built-in agent replays the canonical `rendered` input as native messages, ACP projects it to text, and the driver-level default (used only when a driver exposes no materializer) serializes `rendered` into a JSONL seed. All three fall back to the protocol form for older records written before `rendered` existed.
- **On disk (Chat-V2 two-tier log).** A canvas's namespace `storage.root` is its `.history/` dir (`canvasAcpNamespace(canvasId)`), so the log lives at `.history/chat_v2/<threadId>.events.jsonl` — Tier-1 append-only `AgentStreamEvent` delta log ([`FileEventLogStore`](../../external/agenetes/packages/agenetes/src/event-log.ts)) — plus `.history/chat_v2/<threadId>.turns.jsonl` — Tier-2 folded `AgentTurn`, the **only** tier `history()` reads ([`FileTurnStore`](../../external/agenetes/packages/agenetes/src/turn-store.ts)). Durable workload records sit beside them in `.history/threads.json` ([`FileThreadStore`](../../external/agenetes/packages/agenetes/src/thread-store.ts)). The three file-backed stores plus the two drivers are wired once via `mountAgenetes` in [agenetes/drivers.ts](../../apps/server/src/modules/agent/agenetes/drivers.ts). Legacy chat files are folded into `chat_v2/` at workspace activation ([`migrate-chat-turns.ts`](../../apps/server/src/modules/storage/migrate-chat-turns.ts)).
- Durable workload records use the strict `agenetes-v2` format. Each record stores `driverSchemaVersion`, the complete opaque `WorkloadSpec`, and `AgentStateSnapshot { driverState, metadata? }`; malformed or unsupported files fail fast. Workspace activation migrates `agenetes-v1` files before any ThreadStore writer opens them, preserving the original as `threads.json.agenetes-v1.bak` and aborting without modification on an invalid record or unknown kind. The selected driver validates its own spec and state. The chat fork endpoint is temporarily unavailable because the existing request does not identify a complete target workload; it returns `501` until #321 defines the target-agent contract.
- Intent episodes remain in [store/intent-store.ts](../../apps/server/src/modules/agent/store/intent-store.ts).

---

## 6. External agents (ACP)

[acp/](../../apps/server/src/modules/agent/acp) is the integration layer for external agents. Its trusted built-in catalogue detects and launches GitHub Copilot, Claude Agent, Gemini, Codex, Qwen Code, Kimi Code CLI, OpenCode, Cursor, and Hermes Agent; Manual setup remains available for other ACP-compatible agents and advanced launch commands. Presets with official argument-based full-auto modes expose an auto-approve toggle whose structured recipe controls both the arguments and whether global options precede the ACP subcommand; agents that require environment variables, configuration, or ACP session modes do not expose this launch-command toggle.

- [service.ts](../../apps/server/src/modules/agent/acp/service.ts) `runAcpAgent()` is the external counterpart of `runAgent`: it performs host rendering, constructs the submission, snapshots a unified Agent Profile for a new thread, and drives one Agenetes turn.
- [preprocessor.ts](../../apps/server/src/modules/agent/acp/preprocessor.ts) renders the shared `ChatEnvelope` into canonical `AgentInput[]`. Slash commands become one exclusive `AgentCommandInput`; selection and attachments ride its `context`.
- [`@agenetes/agentlet-host`](../../external/agenetes/packages/agentlet-host) mounts the durably stateless [`@agenetes/agentlet-gateway`](../../external/agenetes/packages/agentlet-gateway), supervises the local agentlet daemon, and injects host-owned authentication. The Gateway owns only live control/session connections, pending RPCs, reconnect buffers, and bounded pre-attach buffering; durable workload and conversation state remains in Agenetes. Ordinary control RPCs time out after 60 seconds, while `server/spawn` has a separate 240-second deadline because it includes ACP `initialize` plus session lifecycle bootstrap, whose two sequential requests may each take up to 90 seconds.
- [`@agenetes/agent-team`](../../external/agenetes/packages/agent-team) owns the unified Profile registry, Profile schemas, setup state, and manifest-runtime resolution. For current Huabu external chat, `runAcpAgent()` reads the selected Profile and compiles its non-sensitive placement and launch identity in the host composition layer into the canonical opaque ACP spec before calling Agenetes. Command Profiles become concrete command recipes; manifest Profiles become concrete Agent Team recipe references.
- [`@agenetes/acp-driver`](../../external/agenetes/packages/acp-driver) owns the canonical ACP spec/state schemas, session creation/resume, canonical-input flattening, ACP update translation, and durable state up-reporting. The static DriverMap binds `external` directly to this driver. Before opening a manifest-backed session, a host-injected runtime-environment port resolves current Config values and secrets from the Agent Team registry; these values are merged into the spawn environment but never enter the durable `WorkloadSpec` or `threads.json`. This same port keeps migrated manifest threads recoverable. Live spawn and session caches are isolated by `(agentletId, threadId)`, and unavailable targets fail with `placement_unavailable`. Because ACP has no native system instruction channel, the driver prefixes joined `AgentSpec.initialPreamble` fragments to the first ordinary prompt. Command-only turns do not consume the preamble, and the ACP-owned `initialPreambleDelivered` state is persisted independently from `sessionId`. Session control state is deliberately split in two: the agent-reported surface (`currentModeId` / `currentModelId` / `configOptions[].currentValue`) and `selections`, a map of explicit per-thread user choices keyed by config-option id (`mode`, `model`, and agent-defined ids such as `allow_all`). Only a successful `set_mode` / `set_model` / `set_config_option` writes `selections`; agent pushes never do, because agents such as Copilot CLI implement config options as process-global user settings and broadcast one value to every live session, making the agent-reported value answer "what was picked last, anywhere" rather than "what was picked for this thread". `selections` travels with the rest of `AgentMetadata` and is the authoritative per-thread intent. On resume it is restored unconditionally, because the gated meta hydrate stops applying the moment the agent's bootstrap push lands, and is then replayed onto the agent knob by knob. That replay only skips a knob the agent appears to agree with when a live push from this session established the agent's view: when the view was instead restored from disk it is a copy of the user's own last choice — `recordSessionSelection` mirrors mode/model picks onto `current*`, the agent echoes config-option picks back as `currentValue`, and all of it is persisted — so diffing against it would conclude the agent agrees and skip the one push that mattered, leaving a resumed thread asking for permission its pill says it should not. A rejected knob is forgotten only when the agent definitively refuses it (JSON-RPC `-32601` / `-32602`), so a retired model id cannot wedge the thread while a transport failure cannot destroy durable intent. Session open is lazy, so the replay races the very turn that triggered it: the turn's `session/prompt` and every user set-RPC wait on `awaitSelectionReplay` first, bounded so an unresponsive agent delays a turn rather than hanging it.
- External-agent idle suspension is host policy: General Settings persists `idleTimeoutSecs` (10 minutes by default, `0` disables suspension), and Huabu injects the current value when a new or resumed ACP process is spawned. Agentlet never suspends a session while a host JSON-RPC request remains in flight; transport teardown closes the ACP client so pending prompts reject and clean up immediately. The long-lived `AcpAgentHandle` self-repairs a suspended lower-level session lazily on the next turn: it snapshots the closed live entry, preserves a recoverable session ID and metadata, and replaces the process/client/session entry only after native resume or load reconnects. This driver-owned repair does not recreate the Handle or refresh its immutable `AgentCreateContext`; closed-session control operations return `session_suspended` until a prompt triggers repair.
- ACP has no native seam for injecting prior assistant messages, so when native resume is unavailable the driver replays history as one prepended text block. It first projects every durable turn through `projectTextHistoryTurn` (`@agenetes/runtime`), which replaces image bodies with a short placeholder — a base64 payload carries no meaning once flattened into text, and inlining it would only inflate the payload. The _projected_ turns are what gets authorized, so the admission estimate prices the block that is actually sent.
- Before a first turn, Chat hydrates session metadata from cache. A cache miss may prewarm command Profiles through the command-session endpoint, while manifest Profiles remain optimistically available until the first real turn compiles the Profile and opens its ACP session.
- Which knob is rendered, and which value it shows, is decided exactly once by `buildAcpSessionSelectors` in [`@sediment/shared`](../../packages/shared/src/utils/acp-session-selectors.ts). It projects a session-meta snapshot into a flat list of selector descriptors, each carrying the channel a change must be routed back through (`mode` / `model` / `config-option`) and whether the shown value came from this thread's `selections` or from the agent's own report. Modern `configOptions` win over the legacy `availableModes` / `availableModels` lists — some agents publish both, and the legacy model list flattens every base model × reasoning effort — but the legacy lists are normalised into the same descriptor shape rather than dropped, because agents that publish no config options at all still depend on them. A recorded selection is ignored when it no longer fits the knob (wrong primitive type, or a value the agent no longer offers) so a retired model id cannot render an empty pill. Chat reads that list and nothing else. Selecting the `agent-full-access` value of a mode selector opens a compact confirmation popover above and left-aligned with ChatInput before Huabu sends the change; cancelling leaves the active mode unchanged without blocking the canvas behind a full-screen modal.
- [profile-store.ts](../../apps/server/src/modules/agent/acp/profile-store.ts) now retains only unmigrated legacy `cliId=agent-team` records long enough to show migration guidance. Ordinary legacy command Profiles preserve their IDs and use the Huabu server working directory when an old record omitted `cwd`. [profiles.route.ts](../../apps/server/src/modules/agent/acp/profiles.route.ts) is the thin loopback-only HTTP adapter over the unified registry, [spawn-orchestrator.ts](../../external/agenetes/packages/acp-driver/src/spawn-orchestrator.ts) targets the selected daemon, and [daemon.route.ts](../../apps/server/src/modules/agent/acp/daemon.route.ts) exposes supervised-daemon status and restart controls.

The built-in Huabu Agent provider and model catalogue comes from `@earendil-works/pi-ai`; it is separate from external ACP session models. [llm.ts](../../apps/server/src/modules/agent/llm.ts) carries small provider-specific metadata overrides and temporarily augments `openai-codex` with current public Codex model IDs when the installed generated pi-ai registry has not caught up. Each surfaced model carries its pi-ai `cost` (per-token USD) and `contextWindow` when known, which powers cost-aware selection (the utility tier's cheapest-eligible default) and price display. For providers that expose a per-account model entitlement, `getModelsForProviderLive` resolves the live list at request time: GitHub Copilot from Copilot's `GET /models`, and OpenAI from `GET {baseUrl}/models` (filtered to chat models and merged with the static pi-ai metadata via `mergeOpenAIModels`). Both fall back to the augmented static catalogue for display when unauthenticated or the fetch fails. Runtime automatic Utility selection is stricter: it chooses only from models confirmed by the provider/account entitlement and falls back to the configured Chat model when availability cannot be confirmed. The Chat Model saved in Settings is the global default; built-in threads may persist a model and reasoning-effort override from the Chat Input controls, with a pre-first-message choice carried on the initial submission and later choices written to the durable thread settings.

External agents can read/write the canvas through the **reachback** channel (see [agent-reachback.md](./agent-reachback.md)). The shipped ownership migration is recorded in [agenetes-agentlet-gateway-consolidation.md](../proposals/agenetes-agentlet-gateway-consolidation.md).

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

1. Add canvas command/query contracts to `packages/shared/src/types/api/space-operations.ts`; add server-only tool schemas beside `tools/definitions.ts`.
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
  three-layer model of `space_commands` and server-side execution.
- [sketch-node.md](./sketch-node.md) — sketch nodes and the recognition pipeline.
- [agent-reachback.md](./agent-reachback.md) — the reachback channel external
  agents use to read/write the canvas.
