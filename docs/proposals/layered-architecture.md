# Huabu Layered Architecture — Strategic Map

> A three-layer reference model for the Sediment / Huabu project: a **Human-AI Interface (HAI)** layer, an **Agent-as-a-Local-Service (AaaS)** layer, and a **Task Automation** layer. The goal is to name the seams that already exist in the code, tighten the contracts between them, and mark which parts of the middle layer can be extracted to serve other projects. The middle layer has a name — **Agenetes** — the agent control plane that will be extracted as a standalone repo, just as `agentlet` already was (see [§3](#3-layer-2--agenetes-agent-as-a-local-service--protocol-driven) and [§6](#6-extraction--what-becomes-reusable)).
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
│  L2 · Agenetes — Agent-as-a-Local-Service — Protocol-driven   │
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
- **L2 is protocol-driven** — its job is a guarantee, not a feature: *once an agent is defined (e.g. via an agent template), then when it is @-mentioned a session exists to receive user queries and return a stream of agent messages.* It cares about the contract, not what the agent does. This is the layer we name **Agenetes** — an agent *control plane* (`agentlet` : kubelet :: Agenetes : Kubernetes).
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
- Not an API spec. Concrete wire contracts remain governed by [api-design.md](../architecture/api-design.md); a follow-up may deep-dive the AaaS interface (see [§6](#6-extraction--what-becomes-reusable)).

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

## 3. Layer 2 — Agenetes (Agent-as-a-Local-Service) · Protocol-driven

**Driver.** Protocol. This layer succeeds or fails on a single guarantee, not on any feature: **once an agent is defined (e.g. via an agent template), then when it is @-mentioned a session exists to receive user queries and return a stream of agent messages.** It is deliberately incurious about *what* the agent does or *how* the canvas looks — it owns the contract in between.

**Name.** We call this layer **Agenetes** (/ˌædʒəˈniːtiːz/ — "aj-uh-NEE-teez") — an agent *control plane*, coined off `agentlet` the way Kubernetes is coined off kubelet (`agentlet` : kubelet :: **Agenetes** : Kubernetes). `agentlet` is the per-node relay that spawns and babysits *one* runtime; Agenetes is the layer above it that **dispatches** a session to its agentlet, tracks its lifecycle, routes its stream, and persists its log. Today this control plane physically lives inside [`apps/server/src/modules/agent/acp`](../../apps/server/src/modules/agent/acp) — Agenetes embedded in the Huabu server. This proposal names it so it can later be extracted as a standalone repo ([§6](#6-extraction--what-becomes-reusable)).

> **Etymology — why *Agenetes*, not *Agentnetes*.** Kubernetes is Ancient Greek κυβερνήτης (*kubernḗtēs*), "helmsman / governor", from the verb κυβερνάω "to steer, to govern" plus the agent-noun suffix **-ήτης (*-ētēs*)**, "the one who —". (Same root → Latin *gubernare* → English *govern*, and → *cybernetics*.) The commonly-borrowed fragment "-netes" is a mis-cut: the ν belongs to the stem *kubern-*, not to the suffix. So we form the name on the true agentive suffix `-ētēs`, attached to the root **ag-** — which Greek ἄγω (*ágō*, "to lead, drive") and Latin *agō* (present participle *agēns/agentis* → English *agent*) genuinely **share**, both from PIE \*h₂eǵ- "to drive". **Agenetes** = *agen-* (the Latin agentive stem, keeping "agent" legible) + *-ētēs* (the Greek agentive suffix, exactly as in *kubernḗtēs*) — a properly-formed agent noun meaning roughly **"the one who drives / sets in motion"**, which is precisely a control plane's job. It also scans like its model: Ku-ber-NÉ-tēs ⟷ A-ge-NÉ-tēs (Kubernetes /ˌkuːbərˈnɛtiːz/ "koo-ber-NET-eez" ⟷ Agenetes /ˌædʒəˈniːtiːz/ "aj-uh-NEE-teez") — four syllables, stress on the penult, a soft *g* keeping "agent" audible. The alternative "Agentnetes" bolts the whole word *agent* onto the mis-cut "-netes", preserving a false morpheme and an un-Greek *-tn-* cluster.

**Responsibility.** The reusable runtime that turns "an agent" into a managed local service. It decomposes into **four orthogonal dimensions** that must be kept decoupled so they compose freely — the design goal of this layer is that any point in one dimension works with any point in the others:

1. **Definition · Registry · Discover** — *what agents exist.* An agent template is a pure definition (e.g. `{ agentletId, cmd, cwd }` or a built-in profile); adding one registers it but creates no session. This dimension owns the registry, agent profiles, and agent-team manifests, and answers "what can I @-mention?". *(k8s: the API server + declarative specs.)*
2. **Lifecycle** — *the workload state machine.* `spawn` (lazily, on first @-mention) → `resume` (from idle-suspend) → `close` (explicit, idle-timeout, or task completion). This dimension owns nothing about *how bytes move* or *what the agent is* — only a workload's existence and state. Agenetes has **two built-in workload kinds** with different completion semantics (see [§3.2](#32-workload-kinds-job-vs-session)): a **`Session`** (long-lived conversation) and a **`Job`** (run one prompt to completion, then close). *(k8s: the controller reconcile loop — Deployment vs Job; note Agenetes has no scheduler, see [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler).)*
3. **Communication (transport-pluggable)** — *how queries in / messages out move.* User query in (`ChatEnvelope`) → stream of agent messages out (`AgentStreamEvent`), over a **pluggable transport**. Transport is a separate axis from lifecycle and definition; the same `spawn`→`stream`→`close` shape must work across every transport (see the matrix below). *(k8s: the CRI — the runtime interface behind which any runtime plugs in.)*
4. **Persistence · Replay · Subscribe** — *the durable message log.* Every turn is appended to a per-thread log so the conversation survives restarts and session idle-out. Consumers can **replay** history (e.g. "return the last 50 messages of this thread" on reload) and **subscribe** to the live tail (a late-joining client, or a second viewer, catches up then streams). This is orthogonal to transport: the log is the same whether the agent ran in-process or over a remote bridge. *(k8s: etcd + the watch API.)*

Reaching the canvas out-of-band (**RFS** reachback) is a facet of communication: a second channel, parallel to the prompt flow, that a spawned agent uses to read/write canvas state via plain HTTP (no client SDK shipped into the agent).

### 3.1 The transport axis (why it is separate)

The trap this layer must avoid is letting a transport choice leak into the lifecycle or definition dimensions (e.g. "spawn" meaning something different for an in-process agent vs a remote one). Transports Huabu needs to support behind one uniform `spawn / stream / close` + `ChatEnvelope / AgentStreamEvent` contract:

| Transport            | Where the agent runs        | Mechanism                                  | Today                                                        |
| -------------------- | --------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| **Local SDK call**   | In-process (same server)    | pi-agent-core loop, direct function calls  | [`runAgent`](../../apps/server/src/modules/agent/agent.service.ts) |
| **Local ACP CLI**    | Separate local process      | agentlet spawns a CLI harness, ACP stdio   | [`runAcpAgent`](../../apps/server/src/modules/agent/acp/service.ts) + local agentlet |
| **Bridged remote ACP** | Remote machine            | agentlet daemon (WSS bridge), ACP over net | [acp/](../../apps/server/src/modules/agent/acp) + remote agentlet daemon |

Because lifecycle and communication are defined once as transport-agnostic contracts, adding a future transport (e.g. HTTP/SSE agent, MCP server) is a new row here — not a change to the other two dimensions. **This orthogonality is the whole point of the middle layer**: definition × lifecycle × transport × persistence compose, rather than each new agent kind forking the runtime. This uniform transport contract is Agenetes' **Agent Runtime Interface (ARI)** — the direct analogue of the CRI: adding a runtime is a new row, not a fork of the control plane. The in-process `runAgent` is then legible as "a runtime that needs no agentlet" — the *static-pod* case.

### 3.2 Workload kinds (Job vs Session)

Lifecycle is *how* Agenetes reconciles a workload toward its desired state; **the reconcile strategy (declarative desired-state vs imperative spawn) is an internal implementation detail and is deliberately not exposed.** What callers *do* choose is the **workload kind**, which differs only in **completion semantics** — exactly the distinction Kubernetes draws between a long-lived `Deployment`/Service and a run-to-completion `Job`:

| Kind          | Desired state                                              | Completion              | k8s analogue      | Huabu example                                                    |
| ------------- | ---------------------------------------------------------- | ----------------------- | ----------------- | ---------------------------------------------------------------- |
| **`Session`** | "while the thread is live, a conversational session exists" | never (idle-suspend/resume) | Deployment / Service | A canvas `QuestionNode`'s ongoing multi-turn conversation        |
| **`Job`**     | "run this prompt once, stream the result, then close"      | terminal (Complete / Failed) | Job / CronJob     | `deepv-slides-maker`, `hackmd-publisher`, `paper-reviewer` runs  |

Both are **built-in, first-class kinds owned by Agenetes** — not host-defined — because completion semantics *are* the control plane's core responsibility. A host (Huabu) only fills in a workload spec (which agent, what prompt, what reachback resource); it never defines a kind's reconcile logic. The payoff of naming them explicitly:

- **Deterministic teardown** — a `Job` closes and archives its log on reaching a terminal state, instead of relying on idle-timeout heuristics to guess it's done.
- **Retry / restart semantics** — a `Job` can carry `backoffLimit` / `restartPolicy`; a `Session` is simply "resume on next message after idle-suspend".
- **UI legibility** — L1 can tell a one-shot production node from a persistent conversation and render/interact accordingly.

**Kind × driver — a realizability constraint.** The kinds do not compose freely with every runtime driver ([§3.3](#33-what-is-an-agent-runtime-drivers-vs-the-agent-definition)); a `Session`'s rich control plane can only be satisfied by a stateful runtime:

- **`Job` → SDK *or* ACP.** A Job's control plane is near-empty (submit + cancel), which every driver already has. The stateless SDK driver and a spawn-then-close ACP session both realize it. (Most agent-teams today — `deepv-slides-maker`, `paper-reviewer` — are ACP Jobs.)
- **`Session` → ACP only.** A live conversation with in-process state, slash commands, and mode/config switching requires a stateful process, which is the ACP driver. The SDK driver is stateless and cannot hold one (see [§3.4](#34-control-plane-vs-data-plane-and-where-session-state-lives)).

> Today Huabu implicitly runs both kinds through one "session" path: `appId = threadId`, one `QuestionNode` = one thread = one session. Naming `Job` splits out the many agent-teams whose semantics are really "do a task, finish" from the truly conversational ones — without changing the transport or definition dimensions.

### 3.3 What is "an agent"? Runtime drivers vs the agent definition

There appear to be *three kinds of agent* in the code today, but they are not three kinds of agent — they are three points on **two orthogonal axes**, and conflating them is the trap:

| Implementation today          | Runtime contract (what the core speaks) | Locality (where it runs)      | Code path                                                                     |
| ----------------------------- | --------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| SDK-wrapped (built-in Hubble) | native SDK (pi-agent-core, in-process)  | in-process                    | [`runAgent`](../../apps/server/src/modules/agent/agent.service.ts)            |
| Local ACP CLI                 | ACP (JSON-RPC over stdio)               | local process                 | `runAcpAgent` → agentlet daemon on localhost                                  |
| Bridged remote ACP            | ACP (JSON-RPC over stdio)               | remote process + WSS bridge   | `runAcpAgent` → remote agentlet daemon                                        |

Two consequences fall out of this table:

1. **Locality is not Agenetes' concern — it is agentlet's whole reason to exist.** "Local ACP" collapses into "remote ACP" in the code precisely because *local* is just "the agentlet daemon runs on localhost". Whether the agent sits in-process, next door, or on another continent is a placement decision owned entirely below the ARI line (agentlet = kubelet, which abstracts node placement + NAT traversal). Agenetes must not model local-vs-remote at all. (This transport-locality is distinct from *resource affinity*: agentlet abstracts *how to reach* a daemon, but *which* daemon holds a session's state is pinned by the spec's binding and is not something L2 chooses or reschedules — see [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler).)
2. **What remains for Agenetes is a single axis — the runtime contract — with (today) two drivers:** an in-process **SDK driver** (`runAgent`) and an **agentlet ACP driver**. These are ARI drivers, exactly as containerd / CRI-O are CRI runtimes; the driver is invisible to whoever *defines* the agent.

So the vocabulary the rest of this doc should use:

- **An agent = a definition** (prompt + tools/skills + which runtime it binds to) — the analogue of a container **image / PodSpec**. This is what a user @-mentions.
- **A runtime driver** = how that definition is executed (SDK in-process vs ACP via agentlet) — the analogue of the **container runtime behind CRI**. Not user-visible.
- **A workload kind** ([§3.2](#32-workload-kinds-job-vs-session)) = completion semantics (`Job` / `Session`) — orthogonal to both.
- **Locality** = agentlet's placement problem — below the ARI, invisible to the control plane.

The composability goal of [§3](#3-layer-2--agenetes-agent-as-a-local-service--protocol-driven) restated: **definition × runtime-driver × workload-kind × locality compose freely.** Today's three "kinds" are three welded vertical slices through these axes; the work is to unweld them.

### 3.4 Control plane vs data plane (and where session state lives)

The ARI carries two message classes, and they behave *very* differently across the two drivers — this asymmetry, not the transport, is the real design question.

**Data plane** — *prompt in → message chunks out.* Already converged on one vocabulary, `AgentStreamEvent`:

| Driver | Input             | Output                | How it reaches `AgentStreamEvent`                                                                                             |
| ------ | ----------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| ACP    | `session/prompt`  | `session/update` stream | translated by [`translator.ts`](../../apps/server/src/modules/agent/acp/translator.ts) (`agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `plan` / `usage_update` → `AgentStreamEvent`) |
| SDK    | `ChatEnvelope`    | `runAgent` yields directly | produced **natively** as `AgentStreamEvent`, no translation                                                             |

The data plane is therefore *already unified* — ACP goes through a translator, the SDK is native, but both speak `AgentStreamEvent` outward. Neither extraction option changes it much.

**Control plane** — *session lifecycle + capabilities.* Here the two drivers are radically asymmetric:

- **ACP has a rich, stateful control surface** addressed to a **live process**: `initialize` (advertising `agentCapabilities`, e.g. [`loadSession`](../../apps/server/src/modules/agent/acp/client.ts)), `session/new`, `session/load` (resume, gated by the `loadSession` capability), `session/cancel`, plus out-of-turn pushes like `available_commands_update` (the **slash-command** catalogue), `config_option_update`, `current_mode_update`.
- **The SDK path has essentially no control plane.** As the `threadId` contract in [`agent.service.ts`](../../apps/server/src/modules/agent/agent.service.ts) documents: the built-in path has *no live process*; its memory is externalized to the on-disk turn log, and the route rebuilds context (`loadTurns` + `rebuildContextMessages`) **before** calling `runAgent`. By then `threadId` no longer drives resume — it is only a provenance tag. There is no `session/new`, no `session/load`, no slash-command catalogue (built-ins do not advertise `availableCommands`).

The deeper axis under the control plane is **where session state lives**:

| Driver | State ownership                     | "Resume" means                     | Role of persistence/replay ([§3](#3-layer-2--agenetes-agent-as-a-local-service--protocol-driven)) |
| ------ | ----------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| ACP    | **in the process** (stateful)       | re-prompt a still-live session; idle-suspend/resume | a **mirror** of process state                                                       |
| SDK    | **in the external log** (stateless) | replay the turn log into a fresh context | **is** the state itself                                                                         |

The insight: **ACP's control verbs only mean something when state lives in the process.** The two drivers are really two *state-ownership* models. This reframes the extraction choice as a control-plane question, not a transport one — and, combined with the workload kinds ([§3.2](#32-workload-kinds-job-vs-session)), it resolves cleanly by **binding the control plane to the workload kind** rather than unifying two control vocabularies:

- **`Job`** has a near-empty control plane (submit + cancel) that both drivers already share — so a Job runs on **SDK or ACP**, and nothing needs unifying.
- **`Session`** carries the full control plane (resume, slash commands, modes) — which only a stateful process provides — so a Session is **ACP-only**.

The rich ARI control vocabulary therefore exists **exactly once**, on the ACP driver, for the Session kind. The stateless SDK driver serves only Jobs, so it never needs to *emulate* ACP control verbs (avoiding the bridge that a "unify on ACP" approach would require), and Agenetes never carries two rival control models. A built-in multi-turn conversation is, under this model, just **N sequential Jobs over the append-only turn log** — which is exactly what [`agent.service.ts`](../../apps/server/src/modules/agent/agent.service.ts) does today, so nothing changes behaviourally.

> The one consequence: a built-in (SDK) agent cannot hold a rich `Session`. If a built-in ever needs slash commands or in-process modes it must acquire in-process state — i.e. become an ACP driver. Whether to keep the SDK driver permanently stateless-Job-only, or leave that door open (and how to weigh ACP's "no context rebuild per turn" against the SDK's log-replay cost), is left to [§8](#8-open-questions).

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
- **Session model** — appId = threadId; one QuestionNode = one thread = one workload; workloads are created lazily on first message. A `Session` idle-suspends and resumes via the agentlet daemon; a `Job` closes on terminal state (see [§3.2](#32-workload-kinds-job-vs-session)). Huabu's canvas layer must not manage workload lifecycle.

### 3.5 The agent definition: content vs mechanism, and how tools bind

[§3.3](#33-what-is-an-agent-runtime-drivers-vs-the-agent-definition) named the *definition* (prompt + skills + tools) as the image/PodSpec analogue. A closer look shows the definition is **not one thing** — it splits along two independent lines that decide *who authors it* and *how it reaches the runtime*. This subsection records the current (as-is) mechanics; the design choices they raise are deferred to [§8](#8-open-questions).

**Content vs mechanism.** The prose of a system prompt and the body of a skill are **product content** — [`ask/AGENT.md`](../../apps/server/src/prompt/agents/ask/AGENT.md) opens with *"a research assistant embedded in a canvas application called Sediment… typed nodes… frames… edges"*, and the system skills are `canvas` / `sketch-gestures` — none of it is generic agent-runtime vocabulary. The **loader** ([`prompt/agents/loader.ts`](../../apps/server/src/prompt/agents/loader.ts), [`prompt/skills/loader.ts`](../../apps/server/src/prompt/skills/loader.ts)) — frontmatter parsing, `{{skillCatalogue}}` / `{{include:}}` rendering, system+user merge, mtime/TTL caching — is generic **mechanism**. So:

- **Content is authored by L1** (the product). User skills already live *outside* the server, under `<workspace>/setting/skills/<id>/SKILL.md` — proof the content is data, not runtime code. System skills being compiled into `apps/server` is a monorepo co-location accident, not a layering intent.
- **Mechanism is owned by L2** (Agenetes): load, render, mount.

**Definition resolution ≈ CRI "image pull".** The clean shape is: a `WorkloadSpec` carries a **reference** to a definition bundle; a **resolver** turns the reference into bytes and mounts it; the **source is pluggable**. The external path already works this way — [`agentlet.yaml`](../../agent-teams) declares `require: (cli-tools / skills / prompts)` and agentlet mounts them at spawn. This distinguishes two registries that Kubernetes keeps separate and that must not be conflated:

| Registry sense       | Stores                                | Agenetes needs it? | Today                                                       |
| -------------------- | ------------------------------------- | ------------------ | ---------------------------------------------------------- |
| **etcd** (metadata)  | *which* definitions exist + reference | **Yes**            | [`acp/profile-store.ts`](../../apps/server/src/modules/agent/acp/profile-store.ts) is exactly this for external profiles |
| **Docker Hub** (blob distribution) | the definition **bytes**, shared/versioned across clusters | **No — YAGNI** | bytes ride with the app bundle (system) or the workspace (user); a resolver reads them locally |

A blob-hosting service only becomes real when skill packs must be shared across workspaces/teams (a marketplace) — and even then it is an *external, pluggable source behind the resolver*, not Agenetes core.

**Tools are a different species — capability, not file.** A prompt/skill is inert **data** you mount; a tool is executable **code** that must run inside the harness. So a tool is never "hosted" as a byte artifact: the definition declares tool **names** (a capability request), and the harness must already have a matching **implementation** registered — the CRI/device-plugin model (a Pod requests `nvidia.com/gpu` by name; the node must actually carry the driver, or admission fails). This gives a binding spectrum, and **the two drivers sit at opposite ends today, neither using MCP**:

| Driver                 | Harness locality        | Tool ABI                                                     | How canvas capability enters                                              | Wire? |
| ---------------------- | ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ | ----- |
| **built-in (SDK)**     | in-process (`apps/server`) | pi-agent-core native `AgentTool { name, description, parameters, execute }` | `execute` closure → [`executeTool`](../../apps/server/src/modules/agent/tools/executor.ts) dispatch → handler **directly `import`s** [`canvas-executor.ts`](../../apps/server/src/modules/canvas/canvas-executor.ts) `executeOnServer` | **none** — same process, direct call |
| **external (ACP)**     | separate / remote process | the CLI's own tools                                          | **RFS** out-of-band HTTP (`$HUABU_RFS_URL`), injected at spawn ([`spawn-orchestrator.ts`](../../apps/server/src/modules/agent/acp/spawn-orchestrator.ts)) | out-of-band HTTP |

The built-in path needs **no MCP** precisely because there is no process boundary: [`tools/index.ts`](../../apps/server/src/modules/agent/tools/index.ts) `buildAgentToolsByNames` resolves the `AGENT.md` `tools:` names against `TOOL_REGISTRY` and wraps each into a pi-agent-core `AgentTool` whose `execute` closure `import`s the canvas domain logic directly. MCP / RFS exist only to cross a boundary the in-process driver does not have. The consequence: the built-in **harness, tool implementations, and canvas-executor are fused into one deployable** — a generic Agenetes harness could not `import canvas-executor`, so extracting the control plane forces a choice (keep the built-in harness as an L1-fused, in-process deployable, or move its tools out-of-band via RFS/MCP). That choice is [§8](#8-open-questions).

Net: pi-agent-core's `AgentTool` *is* the L2-owned tool ABI; the handlers + `executeOnServer` are the L1-owned implementation; Agenetes core owns only the ABI, the name registry, and an **admission check** (requested tools ⊆ what the target harness advertises).

### 3.6 The L1↔L2 binding: an in-process ARI handle modelled on the ACP client role

[§3.5](#35-the-agent-definition-content-vs-mechanism-and-how-tools-bind) settled *what* crosses the seam (a definition reference + tool capabilities). This subsection settles *how* L1 calls L2 — in-process vs API — a question that recurs self-similarly with the tool-binding spectrum: the same "rich in-process object vs serializable wire" tension.

**The binding is an in-process handle produced by a factory the driver registers with L2.** L1 does *not* pre-build a running agent and hand it over — that would strip L2 of lifecycle ownership (no lazy spawn, no restart, no idle-suspend). Instead a driver is **registered once** (receiving the host capabilities it needs, e.g. the canvas port — see below); L2 then **invokes its factory per workload** (lazily, on first message / on restart), passing a serializable `WorkloadSpec`, and holds the resulting handle:

```ts
// (1) Registration — once. Rich, in-process, below the seam. May receive
//     host capability ports (canvas, logger) by injection.
interface AgentDriver {
  readonly id: string;                            // 'builtin' | 'acp' | …
  create(spec: WorkloadSpec): Promise<AgentHandle>; // (2) invoked per workload by L2
}
agenetes.register(driver, { canvas: canvasPort /* in-process, DI */ });

// (2) WorkloadSpec — serializable per-invocation customization (crosses the seam).
interface WorkloadSpec {
  kind: 'Job' | 'Session';  // completion semantics (§3.2) — NOT the driver selector
  binding: BindingSpec;     // dispatch discriminant + the driver-owned sub-spec (tools/session live here — §3.6.1)
  threadId: string;         // the slot / addressing key — L2 routes + persists on this alone (§3.6.1); L1 mints it, L2 treats it opaque
}

// (3) Handle — in-process binding; I/O is serializable messages.
interface AgentHandle {
  submit(input: ChatEnvelope): void;              // data plane in
  events(): AsyncIterable<AgentStreamEvent>;       // data plane out
  control(msg: ControlMsg): Promise<ControlAck>;   // control plane (capability-gated)
  readonly capabilities: AgentCapabilities;        // Job subset vs Session full
}
```

**The handle is modelled on the ACP *client* role — not an HTTP client.** [`AcpAgentClient`](../../apps/server/src/modules/agent/acp/client.ts) shows why the distinction matters — it wires agent→host reverse handlers (`fs/read_text_file`, `session/request_permission`):

| Property      | HTTP client        | ACP client (`AcpAgentClient`)                                                     | Consequence for the handle                     |
| ------------- | ------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| State         | stateless req/resp | stateful session (`initialize → newSession/loadSession → prompt* → cancel`)        | matches the `Session` kind ([§3.2](#32-workload-kinds-job-vs-session)) |
| Direction     | one-way            | **bidirectional peer** — agent calls back (`fs/read_text_file`, `request_permission`) | the reverse channel (today's RFS) folds *into* the protocol |
| Capability    | none               | negotiated at `initialize` (`fs`, `loadSession`)                                  | Job-vs-Session gating ([§3.4](#34-control-plane-vs-data-plane-and-where-session-state-lives)) is built in |
| Serialization | ad-hoc             | **serializable by construction** (JSON-RPC over stdio)                            | the "messages, not closures" rule holds automatically |

**Decision — B: Agenetes owns its contract, modelled on a *subset* of the ACP client role; ACP is one downward driver, not the upward contract.** ACP's control semantics are a superset of what Huabu needs, so Agenetes defines the minimal control vocabulary it actually uses and maps ACP down onto it (rather than inheriting ACP's editor-oriented assumptions and evolution). This is already the *de-facto* stance for the **data plane**: [`translator.ts`](../../apps/server/src/modules/agent/acp/translator.ts) converts ACP `session/update` into `AgentStreamEvent`, so L1 never sees raw ACP. The leak to close is the **control plane** — the `/acp/*` routes (`mode` / `model` / `commands` / `permission`) currently expose ACP concepts straight to the web client; under B they become Huabu-owned control messages with ACP as one implementation behind them.

**Three constraints keep the in-process handle from welding the layers — so it stays "in-process first, remote-ready":**

1. **L2 owns the factory and its invocation** — lifecycle stays a control-plane concern.
2. **The handle's I/O is serializable messages, never method calls carrying live objects / closures** — a closure crossing the seam (e.g. a tool `execute` that `import`s `canvas-executor`, [§3.5](#35-the-agent-definition-content-vs-mechanism-and-how-tools-bind)) is the welding smell. Control ops are messages (`control({ type: 'set_mode', … })`), not rich method calls.
3. **Large payloads go out-of-band** (RFS already fetches node bodies rather than inlining them), keeping events small and any wire binding cheap.

Under these, "in-process" is a *transport optimisation of a serializable contract*, exactly like CRI: the one handle interface gets a direct in-memory binding (built-in fast path, zero serialization) **or** a remote binding (JSON-RPC over stdio via agentlet, or HTTP/SSE) without L1 changing. The two drivers then satisfy the same interface at different capability levels:

- **built-in (SDK) driver** — satisfies the **Job subset** (`submit` + `cancel` + event stream); advertises no `loadSession` / modes. Consistent with [§3.4](#34-control-plane-vs-data-plane-and-where-session-state-lives) (SDK serves only Jobs).
- **ACP driver** — satisfies the **full, capability-gated** surface (resume, modes, slash), for `Session`s.

**The factory has three layers — and this is what keeps "in-process, extracted, *and* fast" simultaneously possible.** The three inputs/outputs of a driver separate cleanly by *who authors them* and *whether they cross the seam*:

| Layer | What | When | Non-serializable OK? | Crosses seam? |
| ----- | ---- | ---- | -------------------- | ------------- |
| **(1) Registration** | driver construction code + injected **host capability ports** (canvas, logger) | once | ✅ closures / live objects / in-process `import` all fine here | **no** — lives below the seam |
| **(2) `WorkloadSpec`** | workload `kind` + `threadId` (the slot) + a `binding` carrying the driver-owned sub-spec (tool selection, `mode` / `session`) | per `create` | ❌ must be serializable | **yes** — the customization channel |
| **(3) Handle** | in-process binding; message I/O | per workload | (object is in-process) | I/O crosses; messages serializable |

This yields the operating rule **"data customizes, code extends"**: a serializable spec *parameterises pre-registered capabilities* (pick this agent, this cwd, enable these tool names), but injecting *new behaviour* (a tool impl not in the registry, a new harness) is a **registration act** (code), not a spec. It is also exactly the [§3.5](#35-the-agent-definition-content-vs-mechanism-and-how-tools-bind) admission model — the spec *requests* tools by name; the registered driver must *carry* them.

**Tools bind into the factory the same way** ([§3.5](#35-the-agent-definition-content-vs-mechanism-and-how-tools-bind) as-is → this model): tool **implementations** (schema + dispatch + the `AgentTool` wrapper — today `definitions.ts` + `handlers/`) live **inside the driver (layer 1)**; **which tools are enabled** comes from the tool names in the binding's driver sub-spec (`BuiltinAgentSpec.tools`, layer 2 — [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)); the tool's `execute` closure is built *locally* from spec data and never crosses the seam. The one subtlety is the host capability a tool needs — canvas mutation. Today [`canvas-write.ts`](../../apps/server/src/modules/agent/tools/handlers/canvas-write.ts) hard-`import`s [`executeOnServer`](../../apps/server/src/modules/canvas/canvas-executor.ts); the extraction-clean form **inverts that into an injected `canvasPort` (layer 1)**. This is the same reverse capability the ACP driver reaches over RFS — one port interface, two bindings:

| Driver | How the canvas port is bound | Serialization cost |
| ------ | ---------------------------- | ------------------ |
| built-in | **in-process injection** (direct call) | **none** — performance preserved |
| ACP | over the wire (RFS / ACP `fs`) | pays serialization |

So decoupling the built-in driver from `canvas-executor` **does not require RFS-ifying its tools**: dependency-inverting the hard `import` into an injected in-process port removes the *compile-time* coupling while keeping the *call* in-process (zero serialization). The hard limit is physics — in-process performance survives extraction only while the driver and the canvas impl share **one process**; crossing a process boundary is what forces RFS. This gives three extraction options for the built-in driver, deferred to [§8](#8-open-questions):

| Option | Module-decoupled? | In-process perf? | Remotable? |
| ------ | ----------------- | ---------------- | ---------- |
| (a) status quo — hard `import`, fused | ❌ | ✅ | ❌ |
| (b) RFS-ify the tools | ✅ | ⚠️ pays serialization | ✅ |
| **(c) dependency-inject an in-process canvas port** | ✅ | ✅ **kept** | ⚠️ only by swapping the port for a remote adapter |

Option **(c)** is the sweet spot for "extract Agenetes as a co-deployed library while keeping the built-in fast."

### 3.6.1 Dispatch, driver affinity, discovery — and why L2 is not a scheduler

[§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) established a serializable `WorkloadSpec` and a per-driver factory. This subsection pins down *how* a spec reaches the right driver — and, by working the Kubernetes analogy to its breaking point, records what Agenetes deliberately is **not**.

**Dispatch is on a discriminated spec, never on a driver name.** L1 does not name a driver; it authors a spec whose **binding** discriminant (today `agentBinding.kind ∈ {internal, external}`, [acp.ts](../../packages/shared/src/types/api/acp.ts)) selects a driver *class*. The spec is therefore a tagged union — each variant carries only the fields its driver consumes, which is why their schemas legitimately differ:

```ts
interface WorkloadSpec {
  kind: 'Job' | 'Session';                    // completion semantics (§3.2)
  threadId: string;                           // the slot / addressing key — the only generic id L2 interprets
  binding:                                    // dispatch discriminant + a driver-owned sub-spec
    | { kind: 'internal'; agentId: AgentMode; spec: BuiltinAgentSpec }               // spec.tools, spec.model — the built-in agent spec
    | { kind: 'external'; alias: string; profileId: string; spec: AcpSessionSpec };  // the ACP session spec
}
```

There are **two independent discriminants**, and conflating them is a naming trap: the **workload kind** (`Job`/`Session` — completion semantics, [§3.2](#32-workload-kinds-job-vs-session)) and the **binding kind** (`internal`/`external` — driver selection). The per-driver payload is nested under the binding as a sub-spec (`BuiltinAgentSpec` / `AcpSessionSpec`) whose schema the driver owns and `safeParse`-validates — so tool selection lives *inside* the built-in binding, never hoisted to the top level.

**`threadId` is the only caller-side identity L2 needs — it is a *slot*, not a description of who called.** L2 routes on it, caches the handle on it, and keys the durable log on it; it never interprets its structure (today L1 mints it via `createId('thread')` and stores it on a canvas `QuestionNode` — an L1 object). Everything the slot *represents* (which canvas, which node, which user) is **held by L1, indexed by `threadId`**, and never enters the L2 contract. This is already how the code behaves: the ACP session key ([`spawn-orchestrator.ts`](../../apps/server/src/modules/agent/acp/spawn-orchestrator.ts) `threadKey(_canvasId, threadId)`) deliberately **ignores `canvasId`**, and host-specific reachback context rides to the (possibly remote) agent as *injected spawn config* — `HUABU_RFS_URL = …/api/rfs/${canvasId}` — not as an L2 addressing field. So when a driver or a remote agent needs the slot's meaning, the **host** injects or resolves it through its own ports ([§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) layer 1); L2 core stays free of canvas/node concepts, exactly the extraction boundary [§6.1](#61-re-splitting-agentletserver-transport-vs-control-plane) draws for the RFS resource shape.

L2 resolves the *binding kind* against a driver registry — the generalisation of today's `binding.kind === 'external' ? runAcpAgent : runAgent` ([agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts)):

```ts
driverRegistry.get(spec.binding.kind).create(spec)   // deterministic — no candidate set, no scoring
```

**Candidacy is advertised by the driver; the binding is decided by L2.** Only a driver knows what it implements, so at registration it *advertises* which binding kinds it serves and which capabilities (tools, control verbs) it carries — an input to routing, not routing itself:

```ts
agenetes.register({
  id: 'acp',                                          // impl name (≠ the 'external' binding kind it serves)
  serves: ['external'],
  capabilities: { control: ['cancel','setMode','resume'], loadSession: true },
  create(spec) { … },
}, { canvas: canvasPort /* injected host capability port, §3.6 */ });
```

L2 stays the authority over the **binding** (which registered driver actually backs a kind) and the **admission** check (the tool names in the binding sub-spec ⊆ what the driver advertises, [§3.5](#35-the-agent-definition-content-vs-mechanism-and-how-tools-bind)). Note the alias in flight: L1 says `external` (contract vocabulary), the driver is `acp` (implementation name) — that indirection is exactly what makes the [§8](#8-open-questions) "move built-ins onto the ACP driver" migration a one-line re-wiring instead of an L1-wide edit.

**Rejected alternative — let the spec carry a driver name.** Tempting, since it deletes the `binding.kind → driver` alias. But it couples L1's contract to L2's *implementation* identifiers: renaming/splitting/merging a driver (precisely the [§6.1](#61-re-splitting-agentletserver-transport-vs-control-plane) re-split and the [§8](#8-open-questions) built-in→ACP migration) would then break every spec, including **persisted** thread bindings. What the alias actually removes is only one hop — the registry lookup (`name → driver instance`, needed for the injected ports and the admission check) cannot be deleted regardless. So the saving is three lines; the cost is coupling the contract to churnable internals. The identifier L1 writes must live in the **contract** namespace (a small, closed, semantic enum), never in L2's implementation namespace — even where the two are 1:1 today.

**Drivers are not fungible — they *are* their resource.** The K8s scheduler assumes interchangeable Nodes with state externalised to a PV; our drivers are the opposite — each is a stateful binding to a resource that cannot move:

| Driver | Bound to | Why not interchangeable |
| ------ | -------- | ----------------------- |
| ACP | a specific agentlet daemon + that machine's filesystem (CWD) | the session's files live on that machine; the live session lives in that process |
| built-in | this process + the tool impls / `canvasPort` injected at registration ([§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role)) | the harness *is* those capabilities, not a generic worker running an image |

So routing has **two dimensions with opposite mutability**: the **class** (`binding.kind → driver type`) is static wiring L2 owns and may re-point ([§8](#8-open-questions)); the **instance** (which daemon / which live session) is *pinned by the spec's resource reference* (`profileId`, a persisted `sessionId`) and is **not** relocatable. This is a control-plane fact distinct from transport-locality ([§3.3](#33-what-is-an-agent-runtime-drivers-vs-the-agent-definition)): agentlet abstracts *how to reach* a daemon, but *which* daemon holds the state is fixed. The failure semantics follow directly — if the bound resource is gone, the workload **cannot be rescheduled elsewhere**; it is rebuilt from durable state (the turn log / persisted session) or it fails. There is no K8s-style "pod drifts to another node". The right K8s reference points are therefore its *least*-fungible primitives — a local-PV Pod pinned by node-affinity, a StatefulSet's stable identity, a device-plugin node — not the default fungible Deployment.

**Therefore L2 is not a scheduler.** A scheduler *chooses* a placement among candidates (scoring, bin-packing, preemption, rescheduling). Agenetes has no such choice: the binding kind selects the driver class deterministically, and the resource reference pins the instance. What remains is not scheduling but **execution**:

| K8s control-plane role | Present in Agenetes? |
| ---------------------- | -------------------- |
| Scheduler (decide placement among candidates) | **No** — placement is declared in the spec, pinned by affinity |
| Admission (gate: requested ⊆ advertised) | Yes — [§3.5](#35-the-agent-definition-content-vs-mechanism-and-how-tools-bind) |
| kubelet / CRI (execute + reconcile a *given* workload) | Yes — `create` + pipe + lifecycle |
| Service / DNS (resolve a name → a fixed endpoint) | Yes — deterministic `binding.kind → driver` |

Agenetes is closer to a **service-mesh sidecar / reverse proxy**: resolve by declared identity, admit, and pipe. Cross-resource scheduling (fleet bin-packing, autoscaling across machines) is an explicit **non-goal** — were it ever needed it would be a *new* layer above Agenetes, not a widening of L2. (The daemon's lazy-spawn / idle-suspend / resume is lifecycle *reconcile* of one already-bound resource — a kubelet job — not placement selection.)

**The registry has two faces.** Registration (above) is the *downward* face; the *upward* face is a **discovery API** — the read side of the Definition/Discover dimension ([§3](#3-layer-2--agenetes-agent-as-a-local-service--protocol-driven), whose nascent form is [`profile-store.ts`](../../apps/server/src/modules/agent/acp/profile-store.ts)). It projects the registry into a **mechanism-free catalogue** L1 can pick from:

| Discovery exposes (contract layer) | Discovery hides (implementation layer) |
| ---------------------------------- | -------------------------------------- |
| bindable **offerings** — built-in agents (`ask`/`operate`/`sketch`), registered external profiles (alias + profileId) | driver class names (`acp`, `sdk`) |
| each offering's **capabilities** (Job/Session, cancel? modes? slash?) for capability-aware UX | transport, process topology, which machine it binds to |

L1 selects an *offering* (populating a picker, gating buttons by capability) and puts its **semantic reference** into `spec.binding`; L2 still resolves offering → driver internally. This is the same line the whole subsection draws: **L1 speaks semantic identity, L2 owns mechanism.** (K8s parallel: `kubectl api-resources` lists kinds + schemas; it never lists the kubelet or CRI runtime behind them.) A future "same agent, local-fast vs remote backend" choice is expressed as a semantic variant / placement *preference* in the catalogue — still never a driver name.

### 3.7 Walkthroughs — the model against today's code

Two dry runs confirm the [§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) model reconciles with the existing flow; every gap is a control-plane relocation, not a design conflict.

**A. External ACP — a continuous `Session`.** `POST /agent` (external binding) → `runAcpAgent` → [`ensureAcpSession`](../../apps/server/src/modules/agent/acp/service.ts) (recipe resolve → `ensureAgentForThread` lazy-spawns the CLI keyed on `threadId` → `client.initialize()` capability handshake → `client.newSession`) → `client.prompt(sessionId, blocks, onUpdate)` → [`translator.ts`](../../apps/server/src/modules/agent/acp/translator.ts) `session/update → AgentStreamEvent`. Maps as: `ensureAcpSession` ≈ **`create` (lazy get-or-create, handle cached in `acpSessionRegistry`)**; `client.prompt` ≈ **`submit`**; translator stream ≈ **`events()`**; `initialize` ≈ **`capabilities`**; resume-after-idle (persisted `sessionId` → daemon `loadSession`) ≈ **`control({resume})`**, capability-gated — the Session-only rich control. The data plane already *is* decision B. Frictions (all control-plane): no single `WorkloadSpec` (assembled from `agentBinding` + profile); control ops are side-band ACP-shaped REST routes (`/threads/:t/{mode,model,commands,permission}`) rather than one `control()` channel; out-of-turn pushes (`available_commands_update`) are REST-polled, not stream-delivered.

**B. Built-in SDK — a `Job` (the harder tool-binding case).** `POST /agent` (internal) → route's `resumeThreadContext` (`loadAgent(mode)` renders the system prompt + `readWorkspaceMemory`; `loadTurns` + `rebuildContextMessages` rebuild state from the on-disk log) → `runAgent(options)` → `buildToolsForScope` → `buildAgentToolsByNames(cfg.toolNames, ctx)` → `new Agent({ tools, messages, … })` → one-shot generator yields `AgentStreamEvent` natively (no translator). Maps as: the rich construction (`loadAgent` + tool `execute` closures + `canvas-executor` call) = **registered driver (layer 1)**; `cfg.toolNames` + `ctx` = the internal **binding sub-spec** (`BuiltinAgentSpec`) + `threadId` (layer 2); `runAgent` fuses **`create`+`submit`+`events`** into one call — an *ephemeral* handle, no cross-turn retention, no `control` beyond cancel = **the Job subset**; a multi-turn built-in chat is thus **N sequential Jobs over the turn log** (exactly [§3.4](#34-control-plane-vs-data-plane-and-where-session-state-lives), zero behaviour change). Built-in-specific frictions (pure relocation): definition resolution + state rebuild happen in the *route* (should move *into* the driver's `create`, so the spec is fully serializable and both drivers are symmetric); the tool's `canvas-executor` `import` is the exact line to invert into an injected port (option (c) above).

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
L1 ◀── Offering catalogue (agents/profiles + capabilities) ── L2   (discovery; mechanism-free, §3.6.1)
L1 ── WorkloadSpec (kind + binding + prompt) ─▶ L2   (Job or Session; binding.kind selects the driver, §3.2/§3.6.1)
L1 ── ChatEnvelope ───────────────▶ L2      (prompt in; internal & external identical)
L1 ◀── AgentStreamEvent ──────────── L2      (~14 SSE event types; no runtime leak)
L1 ◀── CanvasCommand / Execution ─── L2      (the only way an agent mutates the canvas)
L2 ── ACP spawn + prompt ─────────▶ L3      (session per thread; lazy + idle-suspend)
L2 ◀── ACP updates ───────────────── L3      (translated to AgentStreamEvent)
L2 ◀──▶ RFS (curl) ────────────────  L3      (out-of-band canvas read/write)
```

| Seam    | Contract                       | Source of truth                                                                                       | Rule                                                                          |
| ------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| L1 ↔ L2 | Offering catalogue (discovery) | [acp/profile-store.ts](../../apps/server/src/modules/agent/acp/profile-store.ts) *(nascent)*          | Exposes bindable offerings + capabilities; **never** driver names ([§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)). |
| L1 ↔ L2 | Workload spec (`kind` + `binding`) | [packages/shared/src/types/agent](../../packages/shared/src/types/agent) *(proposed)*             | `Job` vs `Session` is Agenetes-owned; `binding.kind` selects the driver; host fills the spec, never names a driver. |
| L1 ↔ L2 | `ChatEnvelope`                 | [packages/shared/src/types/agent](../../packages/shared/src/types/agent)                              | Single envelope for internal + external; user text rebuilt from it on reload. |
| L1 ↔ L2 | `AgentStreamEvent`             | [packages/shared/src/types/agent/agent.ts](../../packages/shared/src/types/agent/agent.ts)            | L1 renders only these; never pi-agent-core / ACP shapes.                      |
| L1 ↔ L2 | `CanvasCommand` / `Execution`  | [packages/shared/src/types/canvas](../../packages/shared/src/types/canvas)                            | The 14-command agent subset; validated + traced server-side.                  |
| L2 ↔ L3 | ACP (agentlet)                 | [external/agentlet/spec/protocol.md](../../external/agentlet/spec/protocol.md)                         | One ACP session per Sediment thread.                                          |
| L2 ↔ L3 | RFS endpoints                  | [packages/shared/src/types/api/rfs.ts](../../packages/shared/src/types/api/rfs.ts)                    | Plain HTTP; no client tool shipped into the agent.                            |
| L2 ↔ L3 | Agent Team manifest            | [external/agentlet/spec/agent-team.md](../../external/agentlet/spec/agent-team.md)                    | `agentlet.yaml`: `command` + `require` (cli-tools / skills / prompts).        |

**Wire-contract discipline (unchanged, restated for the seams).** Every seam type is defined once under `packages/shared/src/types/*`, validated on the server via `safeParse`, never redefined inside `apps/server` or `apps/web`, and imported into the web bundle as `import type` only (keep the bundle zod-free).

---

## 6. Extraction — what becomes reusable

The strategic payoff is that **L2 minus the RFS canvas-shape is Agenetes: a general-purpose agent control plane** that other projects could adopt. Two extractions are in play, one done and one pending:

- **agentlet** (done) — the per-node relay is already a git subtree pushed to its own upstream ([`external/agentlet`](../../external/agentlet)). It is the transport / kubelet: spawn a runtime, bridge ACP over WSS, traverse NAT. Zero AI logic, zero application knowledge.
- **Agenetes** (scaffolded, extraction pending) — the control plane that today lives inside [`apps/server/src/modules/agent/acp`](../../apps/server/src/modules/agent/acp). Its destination repo already exists and is wired in as a subtree at [`external/agenetes`](../../external/agenetes) (upstream `git@github.com:hai-team/agenetes.git`); it currently holds only placeholder files. The control-plane code is migrated in incrementally per [§7](#7-refactor--sequencing) steps 4–5.

| Extractable capability | Today's location                                        | Canvas-coupling                                        |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| Agent loop + tools/skills scoping     | `agent.service.ts`, `agent/tools`             | Low — tools are per-agent frontmatter, not hardcoded.  |
| Definition/Discover (profiles + manifests) | `acp/profile-store.ts`, `agentlet` agent-team | None — pure config/registry.                     |
| Lifecycle (spawn / resume / close + workload kinds) | `acp/spawn-orchestrator.ts`, agentlet daemon  | None — session-per-thread is a generic key.  |
| Communication (transports + store)    | `acp/*`, `runAgent`                           | Low — envelope/stream are typed and generic.           |
| Persistence/Replay/Subscribe          | `agent/store`, `acp/session-store.ts`         | Low — a per-thread append log of typed messages.       |
| Reachback (RFS)                       | `modules/remote_fs`                           | **High** — the payload is canvas nodes/edges.          |

### 6.1 Re-splitting `@agentlet/server` (transport vs control plane)

The extraction is not only "pull the ACP module out of Huabu" — it also re-draws the line *inside* the existing agentlet packages. Today [`@agentlet/server`](../../external/agentlet/packages/server) is doing double duty: it is both a **transport relay** (its stated charter — "a thin relay, zero AI logic, server-agnostic") and, accidentally, a **mini control plane** (session records, an event log, lifecycle events, a session REST management surface). Agenetes should **absorb** the control-plane half and **hand the transport half back** to agentlet, so each package matches its charter:

| `@agentlet/server` module | Lands in | Why |
| ------------------------- | -------- | --- |
| `host-ws.ts` · `agent-ws.ts` · `connection.ts` | **agentlet** (transport) | Pure WS relay, NAT traversal, raw-ACP fan-out — the CRI/kubelet job. |
| `token-store.ts` · daemon auth | **agentlet** (transport auth) | Connection-level auth, bound to the transport. |
| `data-store.ts` (`SessionStore`, `SessionRecord`) | **Agenetes** (state) | A workload is a control-plane resource — the etcd object. |
| `event-store.ts` (`IEventStorage`, replay) | **Agenetes** (persistence) | This *is* the §3 Persistence/Replay/Subscribe dimension. |
| `SessionSpec` · `SpawnParams` · `StopParams` · `LifecycleEvent` | **Agenetes** (lifecycle) | Desired state + state machine = the controller reconcile loop (not a placement scheduler — [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)). |
| `rest-api.ts` (session management) | **Agenetes** (API server) | The declarative management surface belongs in the control plane. |

The dividing principle mirrors kubelet vs the control plane: **agentlet *executes* a spawn but never *decides its lifecycle*** — when to spawn, how long before idle-suspend, whether to resume or retry (and per which workload kind) are Agenetes' **reconcile** decisions (a controller loop over an already-bound resource, not a placement scheduler — [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)). A useful open question ([§8](#8-open-questions)) is whether the `spawn/stop/suspend` control verbs stay in `@agentlet/protocol` or become a distinct Agenetes↔agentlet ARI contract.

The clean extraction boundary is therefore: **agentlet (transport) + Agenetes (definition/lifecycle/communication/persistence) are project-agnostic**; only the RFS *resource shape* (what "a node" is) is Huabu-specific. A reuse plan would keep the transport + lifecycle generic and let each host define its own reachback resource schema behind the same RFS verbs (`download`/`upload`/`agent`/`skill`).

> Both subtrees are already wired in: agentlet at [`external/agentlet`](../../external/agentlet) (transport, live today) and Agenetes at [`external/agenetes`](../../external/agenetes) (control plane, scaffolded and awaiting migration). Each is pushed to its own upstream, so the extraction is a matter of *moving code into an existing package boundary*, not standing a new one up.

### 6.2 Subtree maintenance

Both `external/agentlet` and `external/agenetes` are git subtrees with their own upstreams; changes under those paths must be **committed separately** from Huabu-only changes so they stay clean for upstream push. Remotes: `agentlet-upstream` and `agenetes-upstream`.

```bash
# push local subtree changes up to the standalone repo
git subtree push --prefix=external/agenetes agenetes-upstream main

# pull upstream changes back down (squashed)
git subtree pull --prefix=external/agenetes agenetes-upstream main --squash
```

---

## 7. Refactor / sequencing

No big-bang. Ordered, low-risk steps that each stand alone:

1. **Adopt the vocabulary.** Land this doc; reference L1/L2/L3 in PR descriptions and new module headers. (This PR.)
2. **Assert the seams in code.** Add lint/dependency checks (extend the existing web-layer dependency rules) so L1 code cannot import L2 internals and L3 manifests cannot import server code. Fail CI on upward imports.
3. **Relocate `intent` conceptually.** Decide whether intent ranking stays under `modules/agent` or moves to an L1-owned `modules/sensemaking`; it is an L1 concern with no agent loop.
4. **Name the Agenetes dimension boundaries.** Group the definition/lifecycle/communication/persistence stores under the Agenetes package — destination already scaffolded at [`external/agenetes`](../../external/agenetes) (or, transitionally, a `modules/agent/agenetes` folder) — with the four dimensions as sub-modules, workload kinds ([§3.2](#32-workload-kinds-job-vs-session)) as first-class types, and transport as a pluggable ARI ([§3.1](#31-the-transport-axis-why-it-is-separate)) — so the composability and the extraction seam from [§6](#6-extraction--what-becomes-reusable) are visible in the tree, not just in prose.
5. **Re-split `@agentlet/server`.** Move the control-plane half (session/event stores, lifecycle types, session REST) into Agenetes and leave `@agentlet/server` as pure transport, per the table in [§6.1](#61-re-splitting-agentletserver-transport-vs-control-plane). Touches the `external/agentlet` and `external/agenetes` subtrees — commit each separately for clean upstream push ([§6.2](#62-subtree-maintenance)).
6. **Generalise RFS resource shape.** Introduce a host-defined resource schema behind the RFS verbs so a second project can plug a non-canvas resource in. (Depends on step 4; only pursue when a real second consumer appears.)

Steps 1–2 are this proposal's concrete deliverables; 3–6 are follow-ups that each merit their own review before starting.

---

## 8. Open questions

- Does `intent` ranking belong to L1 (sense-making) or stay in the agent module for proximity to context assembly? (§7 step 3.)
- **Extracting the built-in (SDK) driver: which decoupling, and does it migrate onto ACP?** [§3.4](#34-control-plane-vs-data-plane-and-where-session-state-lives) leaves the SDK driver serving only `Job`s. [§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) reframes the extraction crux from a binary into **three options** for the built-in tools' in-process `import` of `canvas-executor`:
  1. **(a) status quo** — hard `import`, harness fused with L1: fast, but not module-decoupled or extractable.
  2. **(b) RFS-ify the tools** — canvas access goes out-of-band: fully decoupled and remotable, but pays per-call serialization.
  3. **(c) dependency-inject an in-process canvas port** — removes the compile-time coupling while keeping the call in-process: module-decoupled *and* fast, but remotable only by later swapping the port for a remote adapter.
  Option (c) suits "extract as a co-deployed library, keep built-in fast"; (b) is required only if the built-in must run in its own process. Orthogonally, whether built-ins should also gain a *rich Session* (in-process state / slash / modes) still means moving them onto the ACP driver — weigh ACP's "no per-turn context rebuild" against the SDK's simpler log-replay.
- **One shared `Job` control surface?** A Job's control plane is submit + cancel on both drivers ([§3.2](#32-workload-kinds-job-vs-session)). *Resolved by [§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) (decision B):* Agenetes defines its own minimal control vocabulary (a subset of the ACP client role), so an SDK Job and an ACP Job satisfy the same seam interface, gated by capabilities. What remains open is the concrete `ControlMsg` / `AgentCapabilities` shape and how much of ACP's control surface the subset admits.
- **Control-plane relocation (from the [§3.7](#37-walkthroughs--the-model-against-todays-code) dry runs).** The seam works today but leaks: (1) there is no single serializable `WorkloadSpec` — it is assembled from `agentBinding` + a server-side profile lookup; (2) control ops are side-band, ACP-shaped REST routes (`/acp/threads/:t/{mode,model,commands,permission}`) exposed straight to L1, rather than one Huabu-owned `control()` channel; (3) out-of-turn pushes (`available_commands_update`) are REST-polled instead of stream-delivered; (4) for the built-in driver, definition resolution + state rebuild happen in the *route*, not inside `create(spec)`. Folding these into the [§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) handle model is a [§7](#7-refactor--sequencing) refactor, largely behaviour-preserving.
- **Residual `canvasId` coupling in the turn log.** [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler) settles that `threadId` alone is the slot key — and the ACP session key (`threadKey`) already ignores `canvasId` — but the built-in turn log is still loaded as `loadTurns(threadId, canvasId)`. Dropping the `canvasId` argument (relying on `threadId`'s global uniqueness) would align persistence with the addressing model and remove a canvas leak from L2's store. Also open: whether `threadId` stays L1-minted (client-supplied, idempotency-key style — today) or gains an L2-minted `uid` alongside it (the K8s `metadata.name` vs `uid` split).
- **How does L1 select an agent without naming a driver?** *Resolved by [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler):* L1 authors a tagged-union `WorkloadSpec` whose `binding.kind` is a semantic, contract-owned discriminant; L2 resolves it against a driver registry (deterministic, no scheduling), gated by admission; a mechanism-free discovery catalogue exposes offerings + capabilities (never driver names). Drivers are non-fungible (pinned to a daemon/process by resource affinity), so L2 is a dispatcher + conduit, **not** a scheduler; cross-resource scheduling is a non-goal. Open sub-parts: the concrete registry/discovery API surface, and whether a `binding.kind` may ever fan out to more than one driver class.
- Should built-in agents (`ask`/`operate`/`sketch`) be reframed as L3 "tasks" that happen to run in-process, or kept as an L2 concern? This doc places their *prompts* in L3 and their *execution path* in L2 — is that split worth the conceptual overhead? (Note: the `Job`/`Session` split from [§3.2](#32-workload-kinds-job-vs-session) is orthogonal to this — a built-in agent can be either kind.)
- Do the `spawn`/`stop`/`suspend` control verbs stay in [`@agentlet/protocol`](../../external/agentlet/packages/protocol), or become a distinct Agenetes↔agentlet ARI contract once the control plane is extracted? ([§6.1](#61-re-splitting-agentletserver-transport-vs-control-plane).)
- What is the minimum viable "second project" that would validate the Agenetes extraction, and does it exist yet?
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
