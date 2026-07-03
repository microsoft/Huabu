# Huabu Layered Architecture — Strategic Map

> A three-layer reference model for the Sediment / Huabu project: a **Human-AI Interface (HAI)** layer, an **Agent-as-a-Local-Service (AaaS)** layer, and a **Task Automation** layer. The goal is to name the seams that already exist in the code, tighten the contracts between them, and mark which parts of the middle layer can be extracted to serve other projects.
>
> Status: **Draft**, awaiting review · Last updated 2026-07-03 · Tracks [#265](https://github.com/hai-team/Sediment/issues/265)

---

## 0. TL;DR

Huabu today is one monorepo with several well-factored subsystems, but the "which subsystem is allowed to depend on which" story is implicit. This proposal makes it explicit by grouping every subsystem into one of three layers — each with a distinct **driver** — and fixing the direction of dependencies between them:

```
┌──────────────────────────────────────────────────────────────┐
│  L1 · Human-AI Interface (HAI)          — Interaction-driven   │
│  Killer scenarios · epic stories · sense-making on the canvas  │
│  auto-layout · semantic zoom · selection · intent · sketch     │
└───────────────▲───────────────────────────┬───────────────────┘
                │ canvas state + intent      │ AaaS client contract
                │ (SSE events, wire types)   │ (HTTP/SSE, zod-first)
┌───────────────┴───────────────────────────▼───────────────────┐
│  L2 · Agent-as-a-Local-Service (AaaS)   — Protocol-driven      │
│  Define (template) → @-mention → session → stream of messages  │
│  Definition · Lifecycle · Communication · Persistence/Replay   │
└───────────────▲───────────────────────────┬───────────────────┘
                │ prompt in / stream out     │ spawn + reachback
                │ (ChatEnvelope, AgentStream) │ (ACP, RFS endpoints)
┌───────────────┴───────────────────────────▼───────────────────┐
│  L3 · Task Automation                   — Task-driven          │
│  Slides making · auto research · publishing · review…          │
│  optimize prompt / skills / tools for per-task performance     │
└────────────────────────────────────────────────────────────────┘
```

The three drivers are the mental model for *who owns a change*:

- **L1 is interaction-driven** — its work items are killer scenarios, epic stories, and user-interaction studies. It owns the skills and tools that make the canvas legible: pretty auto-layout, semantic zoom, selection resolution, intent understanding.
- **L2 is protocol-driven** — its job is a guarantee, not a feature: *once an agent is defined (e.g. via an agent template), then when it is @-mentioned a session exists to receive user queries and return a stream of agent messages.* It cares about the contract, not what the agent does.
- **L3 is task-driven** — its work items are concrete jobs (slides making, auto research, publishing). It optimizes prompt / skills / tools to push per-task performance, without touching the protocol or the UI.

The dependency rule is one-directional: **L1 → L2 → L3 knowledge flows down as contracts; results flow back up as data.** L3 agents never import L1/L2 code; they only speak the wire protocols (ACP prompt flow + RFS reachback). L1 never reaches directly into L3; it always goes through the L2 service boundary.

---

## 1. Motivation

The project is accumulating complexity along three independent axes — each with its own driver, cadence, and owner — that today live tangled together:

1. **Interaction-driven** — how humans make sense of the canvas (rendering, auto-layout, semantic zoom, selection, intent). Churns fastest, driven by killer-scenario and epic-story work.
2. **Protocol-driven** — how an agent, once defined, gets a session on @-mention and streams messages back. The reusable "runtime" that has nothing canvas-specific about it except the reachback surface.
3. **Task-driven** — what individual agents actually do (make slides, auto research, publish, review) and how their prompt/skills/tools are tuned for performance. Grows without bound, contributed by many people / teams.

Mixing these makes ownership fuzzy, slows parallel work, and blocks the stated goal of **extracting common functions to serve more projects**. A layer only has value if its boundary is a real contract. This doc's job is to (a) declare the three layers, (b) map every current subsystem into exactly one, and (c) specify the contract on each seam so the layers can evolve — and be reused — independently.

### Non-goals

- Not a rewrite. Almost every box below already exists; this is a naming + boundary-tightening exercise.
- Not a new extension protocol. The agent-as-plugin model ([agent-teams-as-extensions.md](../architecture/agent-teams-as-extensions.md)) stays; this proposal locates it as the L2↔L3 seam.
- Not an API spec. Concrete wire contracts remain governed by [api-design.md](../architecture/api-design.md); a follow-up may deep-dive the AaaS interface (see [§6](#6-extraction-what-becomes-reusable)).

---

## 2. Layer 1 — Human-AI Interface (HAI) · Interaction-driven

**Driver.** Interaction. The work items here are killer scenarios, epic stories, and user-interaction studies — "what should it *feel* like to think on this canvas?" — not runtime plumbing.

**Responsibility.** Everything about a human making sense of, and expressing intent over, the infinite canvas. Rendering nodes/edges/frames, spatial interaction, selection, sketch input, and turning fuzzy gestures into explicit operations. It also owns the **interaction skills/tools** that make the canvas legible — pretty auto-layout, semantic zoom, alignment/distribution, snapping — i.e. functions whose entire purpose is human comprehension. This layer *owns the canvas as a cognitive space*; it does not know how any agent is implemented.

**What lives here**

| Subsystem                     | Where                                                                                                 | Doc                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Web app (React canvas)        | [apps/web/src](../../apps/web/src)                                                                     | [web-architecture.md](../architecture/web-architecture.md)                       |
| Desktop shell                 | [apps/desktop](../../apps/desktop)                                                                     | —                                                                                |
| Canvas storage (on-disk)      | [apps/server/src/modules/canvas](../../apps/server/src/modules/canvas)                                 | [canvas-storage.md](../architecture/canvas-storage.md)                           |
| Canvas command engine         | [packages/shared/src/canvas-engine](../../packages/shared/src/canvas-engine)                          | [canvas-command-architecture.md](../architecture/canvas-command-architecture.md) |
| Real-time sync                | [apps/server/src/modules/canvas](../../apps/server/src/modules/canvas)                                 | [canvas-realtime-sync.md](../architecture/canvas-realtime-sync.md)               |
| Node preprocessing            | [apps/server/src/modules/preprocessing](../../apps/server/src/modules/preprocessing)                  | [node-preprocessing.md](../architecture/node-preprocessing.md)                   |
| Intent ranking (sense-making) | [intent.service.ts](../../apps/server/src/modules/agent/intent.service.ts)                            | [agent-context.md](../architecture/agent-context.md)                             |

**Boundary owned by L1.** The `CanvasUiIntent → CanvasCommand → CanvasExecution` three-layer model is L1-internal: `CanvasUiIntent` is web-only and must not leak downward, while `CanvasCommand` / `CanvasExecution` are the shared JSON that L2 agents emit *back into* L1. That shared command schema is the ground truth of what an agent is allowed to do to the canvas.

> Note on placement: `intent` ranking is physically inside `modules/agent` today, but conceptually it serves L1 sense-making (it has `tools: []` and runs no agent loop). It is listed here to signal intent; a future move is optional (see [§7](#7-refactor--sequencing)).

---

## 3. Layer 2 — Agent-as-a-Local-Service (AaaS) · Protocol-driven

**Driver.** Protocol. This layer succeeds or fails on a single guarantee, not on any feature: **once an agent is defined (e.g. via an agent template), then when it is @-mentioned a session exists to receive user queries and return a stream of agent messages.** It is deliberately incurious about *what* the agent does or *how* the canvas looks — it owns the contract in between.

**Responsibility.** The reusable runtime that turns "an agent" into a managed local service. It decomposes into **four orthogonal dimensions** that must be kept decoupled so they compose freely — the design goal of this layer is that any point in one dimension works with any point in the others:

1. **Definition · Registry · Discover** — *what agents exist.* An agent template is a pure definition (e.g. `{ agentletId, cmd, cwd }` or a built-in profile); adding one registers it but creates no session. This dimension owns the registry, agent profiles, and agent-team manifests, and answers "what can I @-mention?".
2. **Lifecycle** — *the session state machine.* `spawn` (lazily, on first @-mention) → `resume` (from idle-suspend) → `close` (explicit or idle-timeout). One thread = one session (appId = threadId). This dimension owns nothing about *how bytes move* or *what the agent is* — only the session's existence and state.
3. **Communication (transport-pluggable)** — *how queries in / messages out move.* User query in (`ChatEnvelope`) → stream of agent messages out (`AgentStreamEvent`), over a **pluggable transport**. Transport is a separate axis from lifecycle and definition; the same `spawn`→`stream`→`close` shape must work across every transport (see the matrix below).
4. **Persistence · Replay · Subscribe** — *the durable message log.* Every turn is appended to a per-thread log so the conversation survives restarts and session idle-out. Consumers can **replay** history (e.g. "return the last 50 messages of this thread" on reload) and **subscribe** to the live tail (a late-joining client, or a second viewer, catches up then streams). This is orthogonal to transport: the log is the same whether the agent ran in-process or over a remote bridge.

Reaching the canvas out-of-band (**RFS** reachback) is a facet of communication: a second channel, parallel to the prompt flow, that a spawned agent uses to read/write canvas state via plain HTTP (no client SDK shipped into the agent).

### 3.1 The transport axis (why it is separate)

The trap this layer must avoid is letting a transport choice leak into the lifecycle or definition dimensions (e.g. "spawn" meaning something different for an in-process agent vs a remote one). Transports Huabu needs to support behind one uniform `spawn / stream / close` + `ChatEnvelope / AgentStreamEvent` contract:

| Transport            | Where the agent runs        | Mechanism                                  | Today                                                        |
| -------------------- | --------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| **Local SDK call**   | In-process (same server)    | pi-agent-core loop, direct function calls  | [`runAgent`](../../apps/server/src/modules/agent/agent.service.ts) |
| **Local ACP CLI**    | Separate local process      | agentlet spawns a CLI harness, ACP stdio   | [`runAcpAgent`](../../apps/server/src/modules/agent/acp/service.ts) + local agentlet |
| **Bridged remote ACP** | Remote machine            | agentlet daemon (WSS bridge), ACP over net | [acp/](../../apps/server/src/modules/agent/acp) + remote agentlet daemon |

Because lifecycle and communication are defined once as transport-agnostic contracts, adding a future transport (e.g. HTTP/SSE agent, MCP server) is a new row here — not a change to the other two dimensions. **This orthogonality is the whole point of the middle layer**: definition × lifecycle × transport × persistence compose, rather than each new agent kind forking the runtime.

**What lives here** (grouped by the four dimensions)

| Dimension                | Subsystem                                                                                             | Doc                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Definition/Discover**  | [acp/profile-store.ts](../../apps/server/src/modules/agent/acp/profile-store.ts) · [agentlet.yaml manifests](../../agent-teams) | [agent-teams-as-extensions.md](../architecture/agent-teams-as-extensions.md) |
| **Lifecycle**            | [acp/spawn-orchestrator.ts](../../apps/server/src/modules/agent/acp/spawn-orchestrator.ts) · [acp/session-registry.ts](../../apps/server/src/modules/agent/acp/session-registry.ts) | [agent-architecture.md §6](../architecture/agent-architecture.md) |
| **Comms — local SDK**    | [agent.service.ts](../../apps/server/src/modules/agent/agent.service.ts) `runAgent`                   | [agent-architecture.md](../architecture/agent-architecture.md)             |
| **Comms — ACP (local/remote)** | [acp/service.ts](../../apps/server/src/modules/agent/acp/service.ts) · [acp/translator.ts](../../apps/server/src/modules/agent/acp/translator.ts) | [agent-architecture.md §6](../architecture/agent-architecture.md) |
| **Comms — reachback**    | [modules/remote_fs](../../apps/server/src/modules/remote_fs)                                          | [agent-reachback-rfs.md](./agent-reachback-rfs.md)                         |
| **Persistence/Replay/Subscribe** | [agent/store](../../apps/server/src/modules/agent/store) (`chat-thread-store.ts`, `intent-store.ts`) · [acp/session-store.ts](../../apps/server/src/modules/agent/acp/session-store.ts) | [agent-architecture.md §5](../architecture/agent-architecture.md) |
| Transport (agentlet)     | [external/agentlet](../../external/agentlet)                                                          | [external/agentlet/spec](../../external/agentlet/spec)                      |
| Tools & skills           | [agent/tools](../../apps/server/src/modules/agent/tools) · [prompt/skills](../../apps/server/src/prompt/skills) | [agent-architecture.md](../architecture/agent-architecture.md)    |
| Context assembly         | [agent/conversation](../../apps/server/src/modules/agent/conversation)                                | [agent-context.md](../architecture/agent-context.md)                       |
| Memory curator           | [agent/memory](../../apps/server/src/modules/agent/memory)                                            | [agent-memory.md](../architecture/agent-memory.md)                         |

**Boundaries owned by L2.**

- **Upward to L1** — the pair `ChatEnvelope` (in) / `AgentStreamEvent` (out). L1 sends an envelope and renders a stream of ~14 event types; it has *zero* awareness of pi-agent-core or ACP internals ([useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts)). Internal and external agents share the same envelope, so L1 cannot tell them apart.
- **Downward to L3** — two protocols: the **ACP prompt→response** flow (spawn + message passing) and the **RFS** endpoints (`download` / `upload` / `agent` / `skill` under `$HUABU_RFS_URL`) for out-of-band canvas access. No Huabu client code is shipped into the agent; a plain `curl` is enough.
- **Session model** — appId = threadId; one QuestionNode = one thread = one session; sessions are created lazily on first message and idle-suspend via the agentlet daemon. Huabu's canvas layer must not manage session lifecycle.

---

## 4. Layer 3 — Task Automation · Task-driven

**Driver.** The task. Work items are concrete jobs — make slides, do auto research, publish content, review a paper — and the metric is *per-task performance*. The core activity here is tuning **prompt / skills / tools** for a given task until it produces good results; it is measured on outcomes, not on protocol correctness or UI polish.

**Responsibility.** Concrete, domain-specific agents that *do a job*. Each is defined declaratively and speaks only L2's wire protocols — it never imports Huabu code. Improving a task means iterating on its prompt, the skills it pulls in, and the tools/CLIs on its PATH — all within the L2 contract, changing nothing above it.

**What lives here**

| Kind                   | Where                                                       | Notes                                                                      |
| ---------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Bundled Agent Teams    | [agent-teams/](../../agent-teams)                           | `deepv-slides-maker`, `hackmd-publisher`, `paper-reviewer`                 |
| Built-in agent prompts | [prompt/agents](../../apps/server/src/prompt/agents)        | `ask` / `operate` / `sketch` — behaviour, not runtime, lives here          |
| External harnesses     | Claude Code · Copilot CLI · Gemini · custom                 | Connected through the L2 ACP bridge                                        |

**Boundary owned by L3.** An L3 agent is a *manifest + prompt + tools it happens to have on its PATH* (`agentlet.yaml` → `command` / `require`). Its only contract with the rest of the system is: receive a prompt via ACP, optionally read/write the canvas via RFS, stream results back. This is exactly the "agent IS the plugin system" thesis — the interface is natural language + tool use, not an SDK.

> **Built-in vs external in L3.** Built-in agents (`ask`/`operate`/`sketch`) run *inside* the L2 process via the pi-agent-core loop; external agents run in a separate process behind agentlet. Both are L3 "task definitions" from the layering view — what differs is only which L2 execution path ([`runAgent`](../../apps/server/src/modules/agent/agent.service.ts) vs [`runAcpAgent`](../../apps/server/src/modules/agent/acp/service.ts)) drives them. Keeping both under one layer is deliberate: it lets a task migrate from built-in to external without touching L1.

---

## 5. Inter-layer contracts (the seams)

The layers are only real if these seams are stable. Each is already a zod-first / typed contract per [api-design.md](../architecture/api-design.md):

```
L1 ── ChatEnvelope ───────────────▶ L2      (prompt in; internal & external identical)
L1 ◀── AgentStreamEvent ──────────── L2      (~14 SSE event types; no runtime leak)
L1 ◀── CanvasCommand / Execution ─── L2      (the only way an agent mutates the canvas)
L2 ── ACP spawn + prompt ─────────▶ L3      (session per thread; lazy + idle-suspend)
L2 ◀── ACP updates ───────────────── L3      (translated to AgentStreamEvent)
L2 ◀──▶ RFS (curl) ────────────────  L3      (out-of-band canvas read/write)
```

| Seam    | Contract                       | Source of truth                                                                                       | Rule                                                                          |
| ------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| L1 ↔ L2 | `ChatEnvelope`                 | [packages/shared/src/types/agent](../../packages/shared/src/types/agent)                              | Single envelope for internal + external; user text rebuilt from it on reload. |
| L1 ↔ L2 | `AgentStreamEvent`             | [packages/shared/src/types/agent/agent.ts](../../packages/shared/src/types/agent/agent.ts)            | L1 renders only these; never pi-agent-core / ACP shapes.                      |
| L1 ↔ L2 | `CanvasCommand` / `Execution`  | [packages/shared/src/types/canvas](../../packages/shared/src/types/canvas)                            | The 14-command agent subset; validated + traced server-side.                  |
| L2 ↔ L3 | ACP (agentlet)                 | [external/agentlet/spec/protocol.md](../../external/agentlet/spec/protocol.md)                         | One ACP session per Sediment thread.                                          |
| L2 ↔ L3 | RFS endpoints                  | [packages/shared/src/types/api/rfs.ts](../../packages/shared/src/types/api/rfs.ts)                    | Plain HTTP; no client tool shipped into the agent.                            |
| L2 ↔ L3 | Agent Team manifest            | [external/agentlet/spec/agent-team.md](../../external/agentlet/spec/agent-team.md)                    | `agentlet.yaml`: `command` + `require` (cli-tools / skills / prompts).        |

**Wire-contract discipline (unchanged, restated for the seams).** Every seam type is defined once under `packages/shared/src/types/*`, validated on the server via `safeParse`, never redefined inside `apps/server` or `apps/web`, and imported into the web bundle as `import type` only (keep the bundle zod-free).

---

## 6. Extraction — what becomes reusable

The strategic payoff is that **L2 minus the RFS canvas-shape is a general-purpose "Agent as a Local Service" runtime** that other projects could adopt:

| Extractable capability | Today's location                                        | Canvas-coupling                                        |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| Agent loop + tools/skills scoping     | `agent.service.ts`, `agent/tools`             | Low — tools are per-agent frontmatter, not hardcoded.  |
| Definition/Discover (profiles + manifests) | `acp/profile-store.ts`, `agentlet` agent-team | None — pure config/registry.                     |
| Lifecycle (spawn / resume / close)    | `acp/spawn-orchestrator.ts`, agentlet daemon  | None — session-per-thread is a generic key.            |
| Communication (transports + store)    | `acp/*`, `runAgent`                           | Low — envelope/stream are typed and generic.           |
| Persistence/Replay/Subscribe          | `agent/store`, `acp/session-store.ts`         | Low — a per-thread append log of typed messages.       |
| Reachback (RFS)                       | `modules/remote_fs`                           | **High** — the payload is canvas nodes/edges.          |

The clean extraction boundary is therefore: **agentlet + the transports + the definition/lifecycle/communication/persistence stores are project-agnostic**; only the RFS *resource shape* (what "a node" is) is Huabu-specific. A reuse plan would keep the transport + lifecycle generic and let each host define its own reachback resource schema behind the same RFS verbs (`download`/`upload`/`agent`/`skill`).

> agentlet is already a git subtree pushed to its own upstream ([`external/agentlet`](../../external/agentlet)), so the transport layer is *literally* an independent package today. This proposal formalises the rest of L2 as the next extraction candidate.

---

## 7. Refactor / sequencing

No big-bang. Ordered, low-risk steps that each stand alone:

1. **Adopt the vocabulary.** Land this doc; reference L1/L2/L3 in PR descriptions and new module headers. (This PR.)
2. **Assert the seams in code.** Add lint/dependency checks (extend the existing web-layer dependency rules) so L1 code cannot import L2 internals and L3 manifests cannot import server code. Fail CI on upward imports.
3. **Relocate `intent` conceptually.** Decide whether intent ranking stays under `modules/agent` or moves to an L1-owned `modules/sensemaking`; it is an L1 concern with no agent loop.
4. **Name the AaaS dimension boundaries.** Group the definition/lifecycle/communication/persistence stores under a single `modules/agent/service` (or a `packages/agent-service`) folder — with the four dimensions as sub-modules and transport as a pluggable interface — so the composability from [§3.1](#31-the-transport-axis-why-it-is-separate) and the extraction seam from [§6](#6-extraction-what-becomes-reusable) are visible in the tree, not just in prose.
5. **Generalise RFS resource shape.** Introduce a host-defined resource schema behind the RFS verbs so a second project can plug a non-canvas resource in. (Depends on step 4; only pursue when a real second consumer appears.)

Steps 1–2 are this proposal's concrete deliverables; 3–5 are follow-ups that each merit their own review before starting.

---

## 8. Open questions

- Does `intent` ranking belong to L1 (sense-making) or stay in the agent module for proximity to context assembly? (§7 step 3.)
- Should built-in agents (`ask`/`operate`/`sketch`) be reframed as L3 "tasks" that happen to run in-process, or kept as an L2 concern? This doc places their *prompts* in L3 and their *execution path* in L2 — is that split worth the conceptual overhead?
- What is the minimum viable "second project" that would validate the L2 extraction, and does it exist yet?
- Does real-time multi-user co-editing ([canvas-realtime-sync-plan.md](./canvas-realtime-sync-plan.md)) stay purely L1, or does it need an L2 notion of "presence" once agents and humans co-edit?

---

## 9. Code entry points

| Layer | Anchor                                                                                       | Role                                                       |
| ----- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| L1    | [apps/web/src/App.tsx](../../apps/web/src/App.tsx)                                            | Canvas app shell / router.                                 |
| L1    | [packages/shared/src/canvas-engine](../../packages/shared/src/canvas-engine)                 | Shared command executor (headless-capable).                |
| L1→L2 | [apps/web/src/hooks/useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts)           | Consumes `AgentStreamEvent`; the L1 side of the seam.      |
| L2    | [apps/server/src/modules/agent/agent.service.ts](../../apps/server/src/modules/agent/agent.service.ts) | Built-in agent loop (`runAgent`).                |
| L2    | [apps/server/src/modules/agent/acp/service.ts](../../apps/server/src/modules/agent/acp/service.ts)     | External agent path (`runAcpAgent`).             |
| L2    | [apps/server/src/modules/remote_fs](../../apps/server/src/modules/remote_fs)                 | RFS reachback surface.                                     |
| L2↔L3 | [external/agentlet/spec/protocol.md](../../external/agentlet/spec/protocol.md)                | ACP transport contract.                                    |
| L3    | [agent-teams/](../../agent-teams)                                                            | Bundled functional agents.                                 |

---

## Related docs

- [agent-architecture.md](../architecture/agent-architecture.md) — the L2 runtime in detail.
- [agent-teams-as-extensions.md](../architecture/agent-teams-as-extensions.md) — the L2↔L3 "agent as plugin" thesis.
- [api-design.md](../architecture/api-design.md) — the zod-first rules every seam obeys.
- [canvas-command-architecture.md](../architecture/canvas-command-architecture.md) — the L1-internal intent/command/execution model.
- [web-architecture.md](../architecture/web-architecture.md) — L1 dependency rules (the template for §7 step 2).
- [agent-reachback-rfs.md](./agent-reachback-rfs.md) — the RFS seam (L2↔L3 reachback).
