# Huabu Layered Architecture — Strategic Map

> A three-layer reference model for the Sediment / Huabu project: a **Human-AI Interface (HAI)** layer, an **Agent-as-a-Local-Service (AaaS)** layer, and a **Task Automation** layer. The goal is to name the seams that already exist in the code, tighten the contracts between them, and mark which parts of the middle layer can be extracted to serve other projects. The middle layer has a name — **Agenetes** — the agent control plane that will be extracted as a standalone repo, just as `agentlet` already was (see [§3](#3-layer-2--agenetes-agent-as-a-local-service--protocol-driven) and [§6](#6-extraction--what-becomes-reusable)).
>
> Status: **Draft**, awaiting review · Last updated 2026-07-05 · Tracks [#265](https://github.com/hai-team/Sediment/issues/265)

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
                │ (AgentRequest, AgentStream) │ (ACP, RFS endpoints)
┌───────────────┴───────────────────────────▼───────────────────┐
│  L3 · Task Automation                   — Task-driven          │
│  Slides making · auto research · publishing · review…          │
│  optimize prompt / skills / tools for per-task performance     │
└────────────────────────────────────────────────────────────────┘
```

The three drivers are the mental model for *who owns a change*:

- **L1 is interaction-driven** — its work items are killer scenarios, epic stories, and user-interaction studies. It owns the skills and tools that make the canvas legible: pretty auto-layout, semantic zoom, selection resolution, intent understanding. It also owns the canvas's **first-party native agents** (`ask`/`operate`/`sketch`) — their prompts, skills, and tools are coupled to *this* app and tuned as part of the product, so they belong to L1, not to a generic task catalogue. *(IDE analogy: L1 is the IDE itself, **including** first-party intelligence like IntelliSense; L3 is the third-party plugin marketplace; L2 is the plugin runtime + protocol.)*
- **L2 is protocol-driven** — its job is a guarantee, not a feature: *once an agent is defined (e.g. via an agent template), then when it is @-mentioned a session exists to receive user queries and return a stream of agent messages.* It cares about the contract, not what the agent does. This is the layer we name **Agenetes** — an agent *control plane* (`agentlet` : kubelet :: Agenetes : Kubernetes).
- **L3 is task-driven** — its work items are concrete jobs (slides making, auto research, publishing). It optimizes prompt / skills / tools to push per-task performance, without touching the protocol or the UI.

The dependency rule is one-directional: **L1 → L2 → L3 knowledge flows down as contracts; results flow back up as data.** L3 agents never import L1/L2 code; they only speak the wire protocols (ACP prompt flow + RFS reachback). L1 never reaches directly into L3; it always goes through the L2 service boundary. L1's first-party native agents are the one place behaviour is *not* in L3 — they are canvas-owned, and L1 supplies them to L2 by **injecting a built-in driver factory** into L2's driver registry (the arrow stays L1→L2; L2 never imports canvas code — see [§4](#4-layer-3--task-automation--task-driven) and [§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role)).

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

**Responsibility.** Everything about a human making sense of, and expressing intent over, the infinite canvas. Rendering nodes/edges/frames, spatial interaction, selection, sketch input, and turning fuzzy gestures into explicit operations. It also owns the **interaction skills/tools** that make the canvas legible — pretty auto-layout, semantic zoom, alignment/distribution, snapping — i.e. functions whose entire purpose is human comprehension. It further owns the canvas's **first-party native agents** (`ask`/`operate`/`sketch`), whose prompts, skills, and tools are canvas-coupled and tuned as part of the product. This layer *owns the canvas as a cognitive space*; it owns *what its native agents are*, but not *how any agent is executed* — that runtime mechanism is L2's.

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
| Built-in native agents (defs) | [prompt/agents](../../apps/server/src/prompt/agents)                                                  | `ask`/`operate`/`sketch` — canvas-coupled prompt/skills/tools; executed via an L2 driver ([§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role)) |

**Boundary owned by L1.** The `CanvasUiIntent → CanvasCommand → CanvasExecution` three-layer model is L1-internal: `CanvasUiIntent` is web-only and must not leak downward, while `CanvasCommand` / `CanvasExecution` are the shared JSON that L2 agents emit *back into* L1. That shared command schema is the ground truth of what an agent is allowed to do to the canvas.

> Note on placement: `intent` ranking is physically inside `modules/agent` today, but conceptually it serves L1 sense-making (it has `tools: []` and runs no agent loop). It is listed here to signal intent; a future move is optional (see [§7](#7-refactor--sequencing)).

---

## 3. Layer 2 — Agenetes (Agent-as-a-Local-Service) · Protocol-driven

**Driver.** Protocol. This layer succeeds or fails on a single guarantee, not on any feature: **once an agent is defined (e.g. via an agent template), then when it is @-mentioned a session exists to receive user queries and return a stream of agent messages.** It is deliberately incurious about *what* the agent does or *how* the canvas looks — it owns the contract in between.

**Name.** We call this layer **Agenetes** (/ˌædʒəˈniːtiːz/ — "aj-uh-NEE-teez") — an agent *control plane*, coined off `agentlet` the way Kubernetes is coined off kubelet (`agentlet` : kubelet :: **Agenetes** : Kubernetes). `agentlet` is the per-node relay that spawns and babysits *one* runtime; Agenetes is the layer above it that **dispatches** a session to its agentlet, tracks its lifecycle, routes its stream, and persists its log. Today this control plane physically lives inside [`apps/server/src/modules/agent/acp`](../../apps/server/src/modules/agent/acp) — Agenetes embedded in the Huabu server. This proposal names it so it can later be extracted as a standalone repo ([§6](#6-extraction--what-becomes-reusable)).

> **Etymology — why *Agenetes*, not *Agentnetes*.** Kubernetes is Ancient Greek κυβερνήτης (*kubernḗtēs*), "helmsman / governor", from the verb κυβερνάω "to steer, to govern" plus the agent-noun suffix **-ήτης (*-ētēs*)**, "the one who —". (Same root → Latin *gubernare* → English *govern*, and → *cybernetics*.) The commonly-borrowed fragment "-netes" is a mis-cut: the ν belongs to the stem *kubern-*, not to the suffix. So we form the name on the true agentive suffix `-ētēs`, attached to the root **ag-** — which Greek ἄγω (*ágō*, "to lead, drive") and Latin *agō* (present participle *agēns/agentis* → English *agent*) genuinely **share**, both from PIE \*h₂eǵ- "to drive". **Agenetes** = *agen-* (the Latin agentive stem, keeping "agent" legible) + *-ētēs* (the Greek agentive suffix, exactly as in *kubernḗtēs*) — a properly-formed agent noun meaning roughly **"the one who drives / sets in motion"**, which is precisely a control plane's job. It also scans like its model: Ku-ber-NÉ-tēs ⟷ A-ge-NÉ-tēs (Kubernetes /ˌkuːbərˈnɛtiːz/ "koo-ber-NET-eez" ⟷ Agenetes /ˌædʒəˈniːtiːz/ "aj-uh-NEE-teez") — four syllables, stress on the penult, a soft *g* keeping "agent" audible. The alternative "Agentnetes" bolts the whole word *agent* onto the mis-cut "-netes", preserving a false morpheme and an un-Greek *-tn-* cluster.

**Responsibility.** The reusable runtime that turns "an agent" into a managed local service. It decomposes into **four orthogonal dimensions** that must be kept decoupled so they compose freely — the design goal of this layer is that any point in one dimension works with any point in the others:

1. **Definition · Registry · Discover** — *what agents exist.* An agent template is a pure definition (e.g. `{ agentletId, cmd, cwd }` or a built-in profile); adding one registers it but creates no session. This dimension owns the registry, agent profiles, and agent-team manifests, and answers "what can I @-mention?". *(k8s: the API server + declarative specs.)*
2. **Lifecycle** — *the workload state machine.* `spawn` (lazily, on first @-mention) → `resume` (from idle-suspend) → `close` (explicit, idle-timeout, or task completion). This dimension owns nothing about *how bytes move* or *what the agent is* — only a workload's existence and state. Agenetes has **two built-in workload kinds** with different completion semantics (see [§3.2](#32-workload-kinds-job-vs-deployment)): a **`Deployment`** (long-lived conversation) and a **`Job`** (run one prompt to completion, then close). *(k8s: the controller reconcile loop — Deployment vs Job; note Agenetes has no scheduler, see [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler).)*
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

**The path is always UI → Huabu Server → Agenetes; Agenetes never talks to the browser directly.** Agenetes is mounted *in-process* by the Huabu Server (imported / instanced), so the L1↔L2 seam splits into two hops with opposite duplex-ness:

```
Browser (L1 UI)
   │  HTTP + SSE + POST       ← half-duplex (SSE is server→browser only)
   ▼
Huabu Server  (L1 glue: routes / SSE bridge / auth)
   │  in-process ARI          ← full-duplex (calls / callbacks / async-iter)
   ▼
Agenetes (L2, mounted in-process)
   ├─ built-in driver → in-process harness
   └─ ACP driver → agentlet daemon (ACP over WS) → CLI agents
```

The half-duplex artefact is confined to the browser hop and bridged *inside the Server*; Agenetes only ever speaks the duplex ARI. The reverse permission call is the tell: it is **one duplex method** at Server↔Agenetes (`requestPermission(params): Promise<decision>`, [`client.ts`](../../apps/server/src/modules/agent/acp/client.ts)), but crossing the half-duplex browser wire it is *split into two correlated halves* — a `permission_request` SSE event down ([useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts)) and a separate `POST …/permission` up ([threads.route.ts](../../apps/server/src/modules/agent/acp/threads.route.ts)), rejoined by `requestId`. This is precisely a transport-axis concern — the same method, expressed differently per transport — and keeping the path is what makes extracting L2 nearly behaviour-preserving ([§6](#6-extraction--what-becomes-reusable)): transport stays in the Server, Agenetes stays transport-free.

### 3.2 Workload kinds (Job vs Deployment)

Lifecycle is *how* Agenetes reconciles a workload toward its desired state; **the reconcile strategy (declarative desired-state vs imperative spawn) is an internal implementation detail and is deliberately not exposed.** What callers *do* choose is the **workload kind**, which differs only in **completion semantics** — exactly the distinction Kubernetes draws between a long-lived `Deployment`/Service and a run-to-completion `Job`:

| Kind          | Desired state                                              | Completion              | k8s analogue      | Huabu example                                                    |
| ------------- | ---------------------------------------------------------- | ----------------------- | ----------------- | ---------------------------------------------------------------- |
| **`Deployment`** | "while the thread is live, a conversational session exists" | never (idle-suspend/resume) | Deployment | A canvas `QuestionNode`'s ongoing multi-turn conversation        |
| **`Job`**     | "run this prompt once, stream the result, then close"      | terminal (Complete / Failed) | Job / CronJob     | `deepv-slides-maker`, `hackmd-publisher`, `paper-reviewer` runs  |

Both are **built-in, first-class kinds owned by Agenetes** — not host-defined — because completion semantics *are* the control plane's core responsibility. A host (Huabu) only fills in a workload spec (which agent, what prompt, what reachback resource); it never defines a kind's reconcile logic.

> **Naming — why `Deployment`, not `Session`.** The kind is a persistent, upper-level *semantic* concept, so it takes the Kubernetes workload-controller name `Deployment` (the canonical run-forever counterpart to `Job`). The word **`Service` is deliberately reserved** for a *different*, future concept — a capability/endpoint exposed *into* L2 for other agents to consume (e.g. agent-as-a-service, MCP, or the RFS surface) — which is exactly what a k8s `Service` (a stable endpoint) means, orthogonal to a workload. Likewise the lower-level **`sessionId`** (the concrete execution instance backing a workload — the "pod") stays a distinct implementation term; `Deployment` avoids colliding with it.

The payoff of naming them explicitly:

- **Deterministic teardown** — a `Job` closes and archives its log on reaching a terminal state, instead of relying on idle-timeout heuristics to guess it's done.
- **Retry / restart semantics** — a `Job` can carry `backoffLimit` / `restartPolicy`; a `Deployment` is simply "resume on next message after idle-suspend".
- **UI legibility** — L1 can tell a one-shot production node from a persistent conversation and render/interact accordingly.

**The initiator is not necessarily a human.** A workload — a `Job` especially — may be initiated by a person (@-mentioning a node), but equally by a **program, a workflow step, or another agent**. This is exactly why the `Job` kind exists: "run once, return a result, close" is the natural shape for programmatic and agent-to-agent invocation. So "who triggers it" is *not* a layer discriminant — an ambient, program-initiated workload (e.g. L1's own intent ranking, [§8](#8-open-questions)) is no less a legitimate workload than a user-initiated chat; layer ownership follows *what it is for*, not *who called it*.

**Kind × driver — a realizability constraint.** The kinds do not compose freely with every runtime driver ([§3.3](#33-what-is-an-agent-runtime-drivers-vs-the-agent-definition)); a `Deployment`'s rich control plane can only be satisfied by a stateful runtime:

- **`Job` → SDK *or* ACP.** A Job's control plane is near-empty (submit + cancel), which every driver already has. The stateless SDK driver and a spawn-then-close ACP session both realize it. (Most agent-teams today — `deepv-slides-maker`, `paper-reviewer` — are ACP Jobs.)
- **`Deployment` → ACP only.** A live conversation with in-process state, slash commands, and mode/config switching requires a stateful process, which is the ACP driver. The SDK driver is stateless and cannot hold one (see [§3.4](#34-control-plane-vs-data-plane-and-where-session-state-lives)).

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
- **A workload kind** ([§3.2](#32-workload-kinds-job-vs-deployment)) = completion semantics (`Job` / `Deployment`) — orthogonal to both.
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

The insight: **ACP's control verbs only mean something when state lives in the process.** The two drivers are really two *state-ownership* models. This reframes the extraction choice as a control-plane question, not a transport one — and, combined with the workload kinds ([§3.2](#32-workload-kinds-job-vs-deployment)), it resolves cleanly by **binding the control plane to the workload kind** rather than unifying two control vocabularies:

- **`Job`** has a near-empty control plane (submit + cancel) that both drivers already share — so a Job runs on **SDK or ACP**, and nothing needs unifying.
- **`Deployment`** carries the full control plane (resume, slash commands, modes) — which only a stateful process provides — so a Deployment is **ACP-only**.

The rich ARI control vocabulary therefore exists **exactly once**, on the ACP driver, for the Deployment kind. The stateless SDK driver serves only Jobs, so it never needs to *emulate* ACP control verbs (avoiding the bridge that a "unify on ACP" approach would require), and Agenetes never carries two rival control models. A built-in multi-turn conversation is, under this model, just **N sequential Jobs over the append-only turn log** — which is exactly what [`agent.service.ts`](../../apps/server/src/modules/agent/agent.service.ts) does today, so nothing changes behaviourally. The concrete message vocabulary of this control plane, and why it is one in-process **duplex** channel (not a side-band), are pinned down in [§3.6.2](#362-the-upward-interface--agenthandle-the-duplex-control-channel-and-capability-negotiation); the split here between *content* updates (data plane) and *affordance* updates (control plane) is the same one that subsection draws.

> The one consequence: a built-in (SDK) agent cannot hold a rich `Deployment`. If a built-in ever needs slash commands or in-process modes it must acquire in-process state — i.e. become an ACP driver. Whether to keep the SDK driver permanently stateless-Job-only, or leave that door open (and how to weigh ACP's "no context rebuild per turn" against the SDK's log-replay cost), is left to [§8](#8-open-questions).

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

- **Upward to L1** — the request (in) / `AgentStreamEvent` (out) pair, both **driver-agnostic**. The **output** is uniform: L1 renders a stream of ~14 event types with *zero* awareness of pi-agent-core or ACP internals ([useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts)), so it cannot tell the drivers apart *from the stream*. The **input** is a **polymorphic, driver-independent `request`** ([§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)): it varies by request *variant* (a canvas selection, a dictionary, …) keyed on its own `type`, **not** by driver — the host's composed `render` normalizes every variant down to the uniform input a driver's `submit(request, render)` feeds to L3. (Only the create-time `spec` is per-driver.)
- **Downward to L3** — two protocols: the **ACP prompt→response** flow (spawn + message passing) and the **RFS** endpoints (`download` / `upload` / `agent` / `skill` under `$HUABU_RFS_URL`) for out-of-band canvas access. No Huabu client code is shipped into the agent; a plain `curl` is enough.
- **Workload model** — appId = threadId; one QuestionNode = one thread = one workload; workloads are created lazily on first message. A `Deployment` idle-suspends and resumes via the agentlet daemon; a `Job` closes on terminal state (see [§3.2](#32-workload-kinds-job-vs-deployment)). Huabu's canvas layer must not manage workload lifecycle.

### 3.5 The agent definition: content vs mechanism, and how tools bind

[§3.3](#33-what-is-an-agent-runtime-drivers-vs-the-agent-definition) named the *definition* (prompt + skills + tools) as the image/PodSpec analogue. A closer look shows the definition is **not one thing** — it splits along two independent lines that decide *who authors it* and *how it reaches the runtime*. This subsection records the current (as-is) mechanics; the design choices they raise are deferred to [§8](#8-open-questions).

**Content vs mechanism.** The prose of a system prompt and the body of a skill are **product content** — [`ask/AGENT.md`](../../apps/server/src/prompt/agents/ask/AGENT.md) opens with *"a research assistant embedded in a canvas application called Sediment… typed nodes… frames… edges"*, and the system skills are `canvas` / `sketch-gestures` — none of it is generic agent-runtime vocabulary. The **loader** ([`prompt/agents/loader.ts`](../../apps/server/src/prompt/agents/loader.ts), [`prompt/skills/loader.ts`](../../apps/server/src/prompt/skills/loader.ts)) — frontmatter parsing, `{{skillCatalogue}}` / `{{include:}}` rendering, system+user merge, mtime/TTL caching — is generic **mechanism**. So:

- **Content is authored by L1** (the product). User skills already live *outside* the server, under `<workspace>/setting/skills/<id>/SKILL.md` — proof the content is data, not runtime code. System skills being compiled into `apps/server` is a monorepo co-location accident, not a layering intent. This is exactly why the **built-in native agents** (`ask`/`operate`/`sketch`) are L1-owned ([§4](#4-layer-3--task-automation--task-driven)): their content *is* L1's, and L2 only runs it via an L1-injected driver.
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
//     A tagged union keyed on the top-level driver route `kind` (§3.6.1); each member
//     owns its `spec` (create config). The per-turn `request` is a SHARED, driver-
//     agnostic union (keyed on its own `type`), the same in every member.
type WorkloadSpec =
  | { kind: 'internal'; workloadKind: WorkloadKind; threadId: ThreadId; spec: BuiltinAgentSpec; request?: AgentRequest }
  | { kind: 'external'; workloadKind: WorkloadKind; threadId: ThreadId; spec: AcpSessionSpec;   request?: AgentRequest };
// `kind` = driver route (public, required); `workloadKind` = Job/Deployment (only
// gates whether `request` is required); `threadId` = the slot L2 routes/persists on.

// (3) Handle — in-process binding; I/O is serializable messages.
interface AgentHandle {
  submit(request: AgentRequest, render: Renderer): void; // data plane in — plain request + composed renderer (§3.6.1)
  events(): AsyncIterable<AgentStreamEvent>;       // data plane out
  control(msg: ControlMsg): Promise<ControlAck>;   // control plane (capability-gated)
  readonly capabilities: AgentCapabilities;        // Job subset vs Deployment full
}
```

**The handle is modelled on the ACP *client* role — not an HTTP client.** [`AcpAgentClient`](../../apps/server/src/modules/agent/acp/client.ts) shows why the distinction matters — it wires agent→host reverse handlers (`fs/read_text_file`, `session/request_permission`):

| Property      | HTTP client        | ACP client (`AcpAgentClient`)                                                     | Consequence for the handle                     |
| ------------- | ------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| State         | stateless req/resp | stateful session (`initialize → newSession/loadSession → prompt* → cancel`)        | matches the `Deployment` kind ([§3.2](#32-workload-kinds-job-vs-deployment)) |
| Direction     | one-way            | **bidirectional peer** — agent calls back (`fs/read_text_file`, `request_permission`) | the reverse channel (today's RFS) folds *into* the protocol |
| Capability    | none               | negotiated at `initialize` (`fs`, `loadSession`)                                  | Job-vs-Deployment gating ([§3.4](#34-control-plane-vs-data-plane-and-where-session-state-lives)) is built in |
| Serialization | ad-hoc             | **serializable by construction** (JSON-RPC over stdio)                            | the "messages, not closures" rule holds automatically |

**Decision — B: Agenetes owns its contract, modelled on a *subset* of the ACP client role; ACP is one downward driver, not the upward contract.** ACP's control semantics are a superset of what Huabu needs, so Agenetes defines the minimal control vocabulary it actually uses and maps ACP down onto it (rather than inheriting ACP's editor-oriented assumptions and evolution). This is already the *de-facto* stance for the **data plane**: [`translator.ts`](../../apps/server/src/modules/agent/acp/translator.ts) converts ACP `session/update` into `AgentStreamEvent`, so L1 never sees raw ACP. The leak to close is the **control plane** — the `/acp/*` routes (`mode` / `model` / `commands` / `permission`) currently expose ACP concepts straight to the web client; under B they become Huabu-owned control messages with ACP as one implementation behind them.

**Three constraints keep the in-process handle from welding the layers — so it stays "in-process first, remote-ready":**

1. **L2 owns the factory and its invocation** — lifecycle stays a control-plane concern.
2. **The handle's I/O is serializable messages, never method calls carrying live objects / closures** — a closure crossing the seam (e.g. a tool `execute` that `import`s `canvas-executor`, [§3.5](#35-the-agent-definition-content-vs-mechanism-and-how-tools-bind)) is the welding smell. Control ops are messages (`control({ type: 'set_mode', … })`), not rich method calls.
3. **Large payloads go out-of-band** (RFS already fetches node bodies rather than inlining them), keeping events small and any wire binding cheap.

Under these, "in-process" is a *transport optimisation of a serializable contract*, exactly like CRI: the one handle interface gets a direct in-memory binding (built-in fast path, zero serialization) **or** a remote binding (JSON-RPC over stdio via agentlet, or HTTP/SSE) without L1 changing. The two drivers then satisfy the same interface at different capability levels:

- **built-in (SDK) driver** — satisfies the **Job subset** (`submit` + `cancel` + event stream); advertises no `loadSession` / modes. Consistent with [§3.4](#34-control-plane-vs-data-plane-and-where-session-state-lives) (SDK serves only Jobs).
- **ACP driver** — satisfies the **full, capability-gated** surface (resume, modes, slash), for `Deployment`s.

**The factory has three layers — and this is what keeps "in-process, extracted, *and* fast" simultaneously possible.** The three inputs/outputs of a driver separate cleanly by *who authors them* and *whether they cross the seam*:

| Layer | What | When | Non-serializable OK? | Crosses seam? |
| ----- | ---- | ---- | -------------------- | ------------- |
| **(1) Registration** | driver construction code + injected **host capability ports** (canvas, logger) | once | ✅ closures / live objects / in-process `import` all fine here | **no** — lives below the seam |
| **(2) `WorkloadSpec`** | top-level `kind` (route) + `workloadKind` + `threadId` (the slot) + the driver-owned `spec` (tool selection, `mode` / `session`) and `request` | per `create` | ❌ must be serializable | **yes** — the customization channel |
| **(3) Handle** | in-process binding; message I/O | per workload | (object is in-process) | I/O crosses; messages serializable |

This yields the operating rule **"data customizes, code extends"**: a serializable spec *parameterises pre-registered capabilities* (pick this agent, this cwd, enable these tool names), but injecting *new behaviour* (a tool impl not in the registry, a new harness) is a **registration act** (code), not a spec. It is also exactly the [§3.5](#35-the-agent-definition-content-vs-mechanism-and-how-tools-bind) admission model — the spec *requests* tools by name; the registered driver must *carry* them.

**Tools bind into the factory the same way** ([§3.5](#35-the-agent-definition-content-vs-mechanism-and-how-tools-bind) as-is → this model): tool **implementations** (schema + dispatch + the `AgentTool` wrapper — today `definitions.ts` + `handlers/`) live **inside the driver (layer 1)**; **which tools are enabled** comes from the tool names in the driver's `spec` (`BuiltinAgentSpec.tools`, layer 2 — [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)); the tool's `execute` closure is built *locally* from spec data and never crosses the seam. The one subtlety is the host capability a tool needs — canvas mutation. Today [`canvas-write.ts`](../../apps/server/src/modules/agent/tools/handlers/canvas-write.ts) hard-`import`s [`executeOnServer`](../../apps/server/src/modules/canvas/canvas-executor.ts); the extraction-clean form **inverts that into an injected `canvasPort` (layer 1)**. This is the same reverse capability the ACP driver reaches over RFS — one port interface, two bindings:

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

**Dispatch is on a discriminated spec — and the discriminant is a top-level `kind` the caller sets.** This is the sharp break from Kubernetes: a k8s caller writes a fungible PodSpec and lets the *scheduler* choose the executor, because the caller must not know which node runs it. Our caller is the opposite — **it knows exactly which driver it wants and names it**, because the drivers are not interchangeable (each *is* a specific resource, below). So the spec's driver route (`kind ∈ {internal, external}`, the contract successor to today's nested `agentBinding.kind`, [acp.ts](../../packages/shared/src/types/api/acp.ts)) is a **required, top-level, public field** — every workload lands on exactly one driver — and the spec is a tagged union keyed on it, each member carrying only the fields its driver consumes:

```ts
// The route (`kind`) is a top-level, public discriminant fixing each driver's
// create-time `spec`. The per-turn `request` is NOT owned by the driver: it is a
// separate, driver-agnostic union keyed on its OWN `type` (a canvas selection, a
// dictionary, …), the SAME shared union in every member.
type WorkloadSpec =
  | { kind: 'internal'; workloadKind: WorkloadKind; threadId: ThreadId;
      spec: BuiltinAgentSpec;  request?: AgentRequest }   // driver differs only in its spec
  | { kind: 'external'; workloadKind: WorkloadKind; threadId: ThreadId;
      spec: AcpSessionSpec;    request?: AgentRequest };
// AgentRequest = discriminatedUnion('type', …) of plain-data variants (see below).
// union-level invariant (superRefine): workloadKind === 'Job' ⇒ request is REQUIRED
// (a Job is self-contained, like a k8s Job's command); a Deployment's first request
// is OPTIONAL — connect first, then submit(request, render) as runtime traffic.
```

**Two orthogonal top-level discriminants — and the earlier rename is what lets them coexist.** The **driver route** (`kind: internal/external` — *which* driver, its `spec` *type*) and the **workload kind** (`workloadKind: Job/Deployment` — completion semantics, [§3.2](#32-workload-kinds-job-vs-deployment), which only decides whether `request` is required) are independent axes. Both now sit at the top level; they do **not** collide only because the lifecycle field was deliberately renamed `workloadKind`, **not** `kind` — reserving the bare `kind` for the already-shipped, persisted driver-route value ([acp.ts](../../packages/shared/src/types/api/acp.ts) `agentBindingSchema`), whose `internal`/`external` values stay stable.

**`request` is driver-agnostic and polymorphic — the variation lives on the request, not the driver.** The earlier instinct was "each driver owns its request," but the canvas fields that motivated it — `attachments`, `canvasContext`, `intentData`, `anchorNodeId` — belong to a canvas-shaped request *variant*, **not** to the internal *driver*: the very same driver's `submit()` may next receive a completely different variant (say, a dictionary to render as a markdown table) from a different caller, with completely different rendering. So the axis of variation is the request *variant*, keyed on its own `type` discriminant (orthogonal to `kind`), and a request is plain, JSON-serializable data (`{ type, content, … }`) — the durable log persists the raw request verbatim (`JSON.stringify`), which stays the source of truth for replay. *Rendering* a request into the uniform input fed to L3 is a **separate, driver-agnostic concern**: each variant declares its own `render`, the host folds the variants into one wire schema plus one `type`-dispatching `render` function, and a driver's `submit(request, render)` receives that composed renderer explicitly and invokes it at the last moment — the driver never owns rendering. This is what keeps [§3.4](#34-control-plane-vs-data-plane-and-where-session-state-lives)'s "output is uniform" true in *both* directions: every variant renders down to the same input shape.

**The contract ships the building blocks; the host composes the closed unions.** Per [§5](#5-inter-layer-contracts-the-seams), the upstream `@agenetes/protocol` package does **not** hard-code `internal`/`external` or any concrete request variant; it exports `defineBinding({ kind, spec })` + `composeWorkloadSpec({ bindings, request })` for the route union, `defineRequest({ type, schema, render })` + `composeRequest([...])` (→ `{ schema, render }`) for the driver-agnostic request union, `workloadKindSchema`, and the branded `threadId`/`sessionId` ids. `apps/server` (the host — it knows every driver and request variant it registers) composes both closed unions and injects the shared `request` union into every `kind` member; the web bundle imports the inferred types as `import type` only (stays zero-zod). Because the server *is* the host and knows all its drivers, validation at the trust boundary is a single typed pass — no `z.unknown()` two-phase is needed on this seam (that would only be for a generic proxy forwarding unknown bindings, which this conduit is not).

**`threadId` is the only caller-side identity L2 needs — it is a *slot*, not a description of who called.** L2 routes on it, caches the handle on it, and keys the durable log on it; it never interprets its structure (today L1 mints it via `createId('thread')` and stores it on a canvas `QuestionNode` — an L1 object). Everything the slot *represents* (which canvas, which node, which user) is **held by L1, indexed by `threadId`**, and never enters the L2 contract. This is already how the code behaves: the ACP session key ([`spawn-orchestrator.ts`](../../apps/server/src/modules/agent/acp/spawn-orchestrator.ts) `threadKey(_canvasId, threadId)`) deliberately **ignores `canvasId`**, and host-specific reachback context rides to the (possibly remote) agent as *injected spawn config* — `HUABU_RFS_URL = …/api/rfs/${canvasId}` — not as an L2 addressing field. So when a driver or a remote agent needs the slot's meaning, the **host** injects or resolves it through its own ports ([§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) layer 1); L2 core stays free of canvas/node concepts, exactly the extraction boundary [§6.1](#61-re-splitting-agentletserver-transport-vs-control-plane) draws for the RFS resource shape.

L2 resolves the *driver route* against a driver registry — the generalisation of today's `binding.kind === 'external' ? runAcpAgent : runAgent` ([agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts)):

```ts
driverRegistry.get(spec.kind).create(spec)   // deterministic — no candidate set, no scoring
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

L2 stays the authority over the **route** (which registered driver actually backs a `kind`) and the **admission** check (the tool names in the driver's `spec` ⊆ what the driver advertises, [§3.5](#35-the-agent-definition-content-vs-mechanism-and-how-tools-bind)). Note the alias in flight: L1 says `external` (contract vocabulary), the driver is `acp` (implementation name) — that indirection is exactly what makes the [§8](#8-open-questions) "move built-ins onto the ACP driver" migration a one-line re-wiring instead of an L1-wide edit.

**Rejected alternative — let the spec carry a driver *implementation* name.** The caller *does* name its driver — but in the **contract** namespace (`kind: internal/external`), never L2's *implementation* identifier (`acp`/`sdk`). Carrying the impl name is tempting since it deletes the `kind → driver` alias, but it couples L1's contract to L2's internals: renaming/splitting/merging a driver (precisely the [§6.1](#61-re-splitting-agentletserver-transport-vs-control-plane) re-split and the [§8](#8-open-questions) built-in→ACP migration) would then break every spec, including **persisted** thread bindings. What the alias actually removes is only one hop — the registry lookup (`name → driver instance`, needed for the injected ports and the admission check) cannot be deleted regardless. So the saving is three lines; the cost is coupling the contract to churnable internals. The identifier L1 writes must live in the **contract** namespace (a small, closed, semantic enum), never in L2's implementation namespace — even where the two are 1:1 today.

**Drivers are not fungible — they *are* their resource.** The K8s scheduler assumes interchangeable Nodes with state externalised to a PV; our drivers are the opposite — each is a stateful binding to a resource that cannot move:

| Driver | Bound to | Why not interchangeable |
| ------ | -------- | ----------------------- |
| ACP | a specific agentlet daemon + that machine's filesystem (CWD) | the session's files live on that machine; the live session lives in that process |
| built-in | this process + the tool impls / `canvasPort` injected at registration ([§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role)) | the harness *is* those capabilities, not a generic worker running an image |

So routing has **two dimensions with opposite mutability**: the **class** (`kind → driver type`) is static wiring L2 owns and may re-point ([§8](#8-open-questions)); the **instance** (which daemon / which live session) is *pinned by the spec's resource reference* (`profileId`, a persisted `sessionId`) and is **not** relocatable. This is a control-plane fact distinct from transport-locality ([§3.3](#33-what-is-an-agent-runtime-drivers-vs-the-agent-definition)): agentlet abstracts *how to reach* a daemon, but *which* daemon holds the state is fixed. The failure semantics follow directly — if the bound resource is gone, the workload **cannot be rescheduled elsewhere**; it is rebuilt from durable state (the turn log / persisted session) or it fails. There is no K8s-style "pod drifts to another node". The right K8s reference points are therefore its *least*-fungible primitives — a local-PV Pod pinned by node-affinity, a StatefulSet's stable identity, a device-plugin node — not the default fungible Deployment.

**Therefore L2 is not a scheduler.** A scheduler *chooses* a placement among candidates (scoring, bin-packing, preemption, rescheduling). Agenetes has no such choice: the binding kind selects the driver class deterministically, and the resource reference pins the instance. What remains is not scheduling but **execution**:

| K8s control-plane role | Present in Agenetes? |
| ---------------------- | -------------------- |
| Scheduler (decide placement among candidates) | **No** — placement is declared in the spec, pinned by affinity |
| Admission (gate: requested ⊆ advertised) | Yes — [§3.5](#35-the-agent-definition-content-vs-mechanism-and-how-tools-bind) |
| kubelet / CRI (execute + reconcile a *given* workload) | Yes — `create` + pipe + lifecycle |
| Service / DNS (resolve a name → a fixed endpoint) | Yes — deterministic `kind → driver` |

Agenetes is closer to a **service-mesh sidecar / reverse proxy**: resolve by declared identity, admit, and pipe. Cross-resource scheduling (fleet bin-packing, autoscaling across machines) is an explicit **non-goal** — were it ever needed it would be a *new* layer above Agenetes, not a widening of L2. (The daemon's lazy-spawn / idle-suspend / resume is lifecycle *reconcile* of one already-bound resource — a kubelet job — not placement selection.)

**The registry has two faces.** Registration (above) is the *downward* face; the *upward* face is a **discovery API** — the read side of the Definition/Discover dimension ([§3](#3-layer-2--agenetes-agent-as-a-local-service--protocol-driven), whose nascent form is [`profile-store.ts`](../../apps/server/src/modules/agent/acp/profile-store.ts)). It projects the registry into a **mechanism-free catalogue** L1 can pick from:

| Discovery exposes (contract layer) | Discovery hides (implementation layer) |
| ---------------------------------- | -------------------------------------- |
| bindable **offerings** — first-party native agents (`ask`/`operate`/`sketch`) + registered external profiles (alias + profileId), presented uniformly by capability | driver class names (`acp`, `sdk`); whether an offering is L1-injected native vs L3-registered external |
| each offering's **capabilities** (Job/Deployment, cancel? modes? slash?) for capability-aware UX | transport, process topology, which machine it binds to |

L1 selects an *offering* (populating a picker, gating buttons by capability) and sets the workload's top-level **route** `kind` accordingly; L2 still resolves offering → driver internally. This is the same line the whole subsection draws: **L1 speaks semantic identity, L2 owns mechanism.** (K8s parallel: `kubectl api-resources` lists kinds + schemas; it never lists the kubelet or CRI runtime behind them.) A future "same agent, local-fast vs remote backend" choice is expressed as a semantic variant / placement *preference* in the catalogue — still never a driver name.

### 3.6.2 The upward interface — `AgentHandle`, the duplex control channel, and capability negotiation

[§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) sketched the handle; this subsection pins down its control surface — why it needs no side-band channel, what its message vocabulary is, and how one interface serves drivers of very different richness.

**The control channel is an in-process duplex — there is no sidecar.** Because the L1↔L2 seam lives *inside* the Huabu Server process ([§3.1](#31-the-transport-axis-why-it-is-separate)), the handle is a genuine bidirectional peer, exactly like the ACP client role over its stdio duplex: host→agent calls and agent→host calls share one logical channel, correlated the way JSON-RPC correlates by `id`. The reverse permission request is therefore a **method the host implements**, not a second channel — an injected port `onPermissionRequest(req): Promise<decision>` that L2 awaits ([`AcpAgentClient`](../../apps/server/src/modules/agent/acp/client.ts) already does this with its per-turn notifier + `resolvePermission`). The browser's SSE-event-down / POST-up split ([§3.1](#31-the-transport-axis-why-it-is-separate)) is *not* part of this contract; it is the Server bridging the duplex onto a half-duplex wire, and it is replaceable by a WebSocket without touching L2. So the "pure-SSE can't answer a reverse RPC" worry is a browser-wire fact, never an L1↔L2 one.

**The vocabulary is a subset of the ACP client role, in two directions.** Refining the handle's `control(msg)` / `events()` into concrete messages — request/response **methods** (need a reply) vs one-way **notifications**:

| Direction | Message | Kind | Capability gate | Consumed by |
| --------- | ------- | ---- | --------------- | ----------- |
| host → agent | `setMode(id)` | method | `modes` advertised | agent / harness |
| host → agent | `setModel(id)` | method | `models` advertised | agent / harness |
| host → agent | `setConfigOption(k,v)` | method | `configOptions` advertised | agent / harness |
| host → agent | `cancel()` | notification | universal | **L2 + agent** (L2 aborts the turn / clears pending permissions) |
| agent → host | `requestPermission(req)` | method (injected port) | agent issues permission requests | **host** (bridges to UI) |
| agent → host | `availableCommandsUpdate` | notification | `slashCommands` | L1 (toolbar) |
| agent → host | `currentModeUpdate` | notification | `modes` | L1 (toolbar) |

**Slash commands follow ACP exactly: discover via control, invoke via the data plane.** The agent advertises its command catalogue as an upward `availableCommandsUpdate` notification; a command is *run* by putting its text (`/web …`) into an ordinary prompt on the **data plane** — there is no `runCommand` control message (ACP spec: *"Commands are run as part of regular prompt requests where the Client includes the command text in the prompt."*). This draws the general line: **content updates (message / tool / plan / thought) are the data plane; affordance/meta updates (commands, mode, permission) are the control plane** — logically distinct, though both may ride one physical SSE stream.

**`AgentHandle` is an anti-corruption wrapper over the ACP client *role* — not a re-export of the ACP SDK.** Modelling the interface on the ACP client role (Decision B, [§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role)) gives a complete, well-worn vocabulary; *wrapping* rather than exposing it means (a) we surface only what Huabu needs and can adapt names, (b) replacing ACP later never reaches L1, and (c) the external driver reuses the SDK's implementation (permission wire, `id`-correlation, schema validation) for free. This is already the de-facto shape: [`runAcpAgent`](../../apps/server/src/modules/agent/acp/service.ts) wraps [`AcpAgentClient`](../../apps/server/src/modules/agent/acp/client.ts) (which wraps the ACP SDK) yet yields only the generic `AgentStreamEvent`, and [`runAgent`](../../apps/server/src/modules/agent/agent.service.ts) (built-in) yields the *same* shape — [agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts) consumes both binding-agnostically. The wrapping happens at the **driver** level, so the interface stays driver-agnostic:

| Layer | Role |
| ----- | ---- |
| `AgentHandle` | our own driver-agnostic interface — the contract; benefit (b) hinges on it being *ours* |
| `AcpAgentHandle` | thin wrapper over the ACP SDK client — external driver; the "reuse SDK" benefit (c) lands here |
| `BuiltinAgentHandle` | wrapper over the in-process harness — built-in driver |

So "gain ACP's features by wrapping the SDK" applies *only* to the external driver: the built-in driver has no SDK client to wrap and must **not** be forced through an in-process ACP loopback merely to acquire a capability it does not need. Whether built-ins should ever run on ACP anyway is the separate [§8](#8-open-questions) trade-off.

**Capabilities are composable, not all-or-nothing.** Rather than one fat interface every driver must fully implement, the handle is a small core plus *segregated* facets a driver opts into (interface-segregation), so a `Job` handle carries no `NotImplemented` stubs:

```ts
interface AgentHandle {  // core — every driver implements this
  submit(request: AgentRequest, render: Renderer): void;  // plain request + composed renderer (§3.6.1); render is driver-agnostic
  events(): AsyncIterable<AgentStreamEvent>;
  close(): void;
  readonly capabilities: AgentCapabilities;   // runtime descriptor (below)
}
interface Cancellable     { cancel(): Promise<void>; }
interface ModeSwitchable  { setMode(id: string): Promise<void>; }
interface ModelSelectable { setModel(id: string): Promise<void>; }
// Behavioural capabilities add NO method: reverse permission is the injected
// onPermissionRequest port; slash is availableCommandsUpdate on events().
```

Callers narrow by capability (`if (isModeSwitchable(h)) h.setMode(id)`). This aligns the surface with the workload kind ([§3.2](#32-workload-kinds-job-vs-deployment)): **Job** = core (+ `Cancellable`); **Deployment** = core + modes + models + slash + permission. The ACP SDK client is the current *superset* implementation; a future richer runtime contributes new facets and the superset is simply their **union**.

**Two artefacts carry a capability, kept in sync deliberately.** (1) compile-time *facet interfaces* (above) give in-process type-narrowing; (2) a serializable **`AgentCapabilities` descriptor** is the single source the **discovery catalogue** ([§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)), the **UI affordances** (which toolbar controls to show), and the **admission gate** all read — structural typing cannot cross the wire or drive a toolbar. As in ACP's own `initialize`, capabilities are negotiated in **two phases mapped onto the [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler) candidacy/binding split**: a driver *class* advertises its candidate capabilities at `register` (static — feeds discovery); a *handle* reports the actually-negotiated set after create/initialize (dynamic — e.g. an ACP agent that advertised no modes). This retires today's ad-hoc probing ([`profile-schema-cache`](../../apps/server/src/modules/agent/acp/profile-schema-cache.ts) / `cached-meta`).

**The capability set is open — extending it is a fixed recipe (open/closed).** `AgentCapabilities` is an open structured object; adding one touches no existing driver:

1. add a field to `AgentCapabilities` (a *method* capability also adds a facet interface; a *behavioural* one adds only the field);
2. define a conservative default for when the field is absent (old drivers → safe degrade);
3. each driver reports its value at negotiation;
4. discovery / UI / admission read that one field.

*Example — "can the user type mid-turn?"* Whether an agent accepts input while still thinking/streaming is a **behavioural** capability (no new method — `submit` is unchanged) that decides whether L1 blocks its input box. It is richer than a boolean, and it *exceeds* the ACP baseline (ACP is strictly turn-based — a second `session/prompt` mid-turn is not in the base model), so it is exactly the kind of capability the union grows beyond ACP:

```ts
turnInput?: 'blocking' | 'queue' | 'concurrent';   // absent ⇒ 'blocking' (most conservative)
```

Most ACP CLI agents report `blocking`; a built-in or richer agent may offer `queue` / `concurrent`. L1 reads it to enable/disable the input box; L2 may use it as light admission (reject a `submit` mid-turn when `blocking`). That the descriptor is *ours* — not ACP's — is what lets it hold capabilities ACP never had, reaffirming Decision B's replaceability.

### 3.7 Walkthroughs — the model against today's code

Two dry runs confirm the [§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) model reconciles with the existing flow; every gap is a control-plane relocation, not a design conflict.

**A. External ACP — a continuous `Deployment`.** `POST /agent` (external binding) → `runAcpAgent` → [`ensureAcpSession`](../../apps/server/src/modules/agent/acp/service.ts) (recipe resolve → `ensureAgentForThread` lazy-spawns the CLI keyed on `threadId` → `client.initialize()` capability handshake → `client.newSession`) → `client.prompt(sessionId, blocks, onUpdate)` → [`translator.ts`](../../apps/server/src/modules/agent/acp/translator.ts) `session/update → AgentStreamEvent`. Maps as: `ensureAcpSession` ≈ **`create` (lazy get-or-create, handle cached in `acpSessionRegistry`)**; `client.prompt` ≈ **`submit`**; translator stream ≈ **`events()`**; `initialize` ≈ **`capabilities`**; resume-after-idle (persisted `sessionId` → daemon `loadSession`) ≈ **`control({resume})`**, capability-gated — the Deployment-only rich control. The data plane already *is* decision B. Frictions (all control-plane): no single `WorkloadSpec` (assembled from `agentBinding` + profile); control ops are side-band ACP-shaped REST routes (`/threads/:t/{mode,model,commands,permission}`) rather than one `control()` channel; out-of-turn pushes (`available_commands_update`) are REST-polled, not stream-delivered.

**B. Built-in SDK — a `Job` (the harder tool-binding case).** `POST /agent` (internal) → route's `resumeThreadContext` (`loadAgent(mode)` renders the system prompt + `readWorkspaceMemory`; `loadTurns` + `rebuildContextMessages` rebuild state from the on-disk log) → `runAgent(options)` → `buildToolsForScope` → `buildAgentToolsByNames(cfg.toolNames, ctx)` → `new Agent({ tools, messages, … })` → one-shot generator yields `AgentStreamEvent` natively (no translator). Maps as: the rich construction (`loadAgent` + tool `execute` closures + `canvas-executor` call) = **registered driver (layer 1)**; `cfg.toolNames` + `ctx` = the internal driver's **`spec`** (`BuiltinAgentSpec`) + `threadId` (layer 2); `runAgent` fuses **`create`+`submit`+`events`** into one call — an *ephemeral* handle, no cross-turn retention, no `control` beyond cancel = **the Job subset**; a multi-turn built-in chat is thus **N sequential Jobs over the turn log** (exactly [§3.4](#34-control-plane-vs-data-plane-and-where-session-state-lives), zero behaviour change). Built-in-specific frictions (pure relocation): definition resolution + state rebuild happen in the *route* (should move *into* the driver's `create`, so the spec is fully serializable and both drivers are symmetric); the tool's `canvas-executor` `import` is the exact line to invert into an injected port (option (c) above).

---

## 4. Layer 3 — Task Automation · Task-driven

**Driver.** The task. Work items are concrete jobs — make slides, do auto research, publish content, review a paper — and the metric is *per-task performance*. The core activity here is tuning **prompt / skills / tools** for a given task until it produces good results; it is measured on outcomes, not on protocol correctness or UI polish.

**Responsibility.** Concrete, domain-specific agents that *do a job*. Each is defined declaratively and speaks only L2's wire protocols — it never imports Huabu code. Improving a task means iterating on its prompt, the skills it pulls in, and the tools/CLIs on its PATH — all within the L2 contract, changing nothing above it.

**What lives here**

| Kind                   | Where                                                       | Notes                                                                      |
| ---------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Bundled Agent Teams    | [agent-teams/](../../agent-teams)                           | `deepv-slides-maker`, `hackmd-publisher`, `paper-reviewer`                 |
| External harnesses     | Claude Code · Copilot CLI · Gemini · custom                 | Connected through the L2 ACP bridge                                        |

**Boundary owned by L3.** An L3 agent is a *manifest + prompt + tools it happens to have on its PATH* (`agentlet.yaml` → `command` / `require`). Its only contract with the rest of the system is: receive a prompt via ACP, optionally read/write the canvas via RFS, stream results back. This is exactly the "agent IS the plugin system" thesis — the interface is natural language + tool use, not an SDK.

> **Built-in agents are L1's, not L3's.** `ask`/`operate`/`sketch` are the canvas's **first-party native agents**: their prompts, skills, and tools are strongly coupled to *this* app (the [`ask` prompt](../../apps/server/src/prompt/agents/ask/AGENT.md) names typed nodes / frames / edges; the tools mutate the canvas in-process) and they are tuned as part of the product experience — so their *ownership* is **L1**, exactly as an IDE's built-in IntelliSense is part of the IDE while third-party language servers are plugins. What is L2's is only the **execution mechanism**: L1 supplies the canvas-specific spec (prompt + tools + `canvasPort` impl) by **injecting a built-in driver factory** into L2's driver registry ([§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role)), and L2 runs it through the same [`AgentHandle`](#362-the-upward-interface--agenthandle-the-duplex-control-channel-and-capability-negotiation) contract as any other driver — never importing canvas code. This keeps the dependency arrow L1→L2 clean and removes the earlier anomaly of an L3 "task" that imports Huabu code. Migrating a built-in onto an external harness (`runAcpAgent`) is therefore a deliberate **re-homing** (L1-owned native → L3 plugin), not a transparent execution-path swap.

---

## 5. Inter-layer contracts (the seams)

The layers are only real if these seams are stable. Each is already a zod-first / typed contract per [api-design.md](../architecture/api-design.md):

```
L1 ◀── Offering catalogue (agents/profiles + capabilities) ── L2   (discovery; mechanism-free, §3.6.1)
L1 ── WorkloadSpec (top-level `kind` route + workloadKind + per-driver spec + shared request) ─▶ L2   (kind selects the driver; workloadKind = Job/Deployment, §3.2/§3.6.1)
L1 ── submit(request, render) ────▶ L2      (data plane in; driver-agnostic request rendered to a uniform input, §3.6.1)
L1 ◀── AgentStreamEvent ──────────── L2      (~14 SSE event types; no runtime leak)
L1 ◀──▶ Control channel ──────────── L2      (host↔agent methods + notifications, capability-gated; in-process duplex, browser hop = SSE↓ + POST↑ bridge, §3.6.2)
L1 ◀── CanvasCommand / Execution ─── L2      (the only way an agent mutates the canvas)
L2 ── ACP spawn + prompt ─────────▶ L3      (session per thread; lazy + idle-suspend)
L2 ◀── ACP updates ───────────────── L3      (translated to AgentStreamEvent)
L2 ◀──▶ RFS (curl) ────────────────  L3      (out-of-band canvas read/write)
```

| Seam    | Contract                       | Source of truth                                                                                       | Rule                                                                          |
| ------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| L1 ↔ L2 | Offering catalogue (discovery) | [acp/profile-store.ts](../../apps/server/src/modules/agent/acp/profile-store.ts) *(nascent)*          | Exposes bindable offerings + capabilities; **never** driver names ([§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)). |
| L1 ↔ L2 | Workload spec (top-level `kind` + `workloadKind` + per-driver `spec` + shared `request`) | [`@agenetes/protocol`](../../external/agenetes/packages/protocol) building blocks + host-composed union *(proposed)* | Top-level `kind` selects the driver; `workloadKind` gates whether `request` is required; the protocol ships `defineBinding`/`composeWorkloadSpec`, the host (`apps/server`) composes the closed union — never names a driver impl ([§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)). |
| L1 ↔ L2 | Driver-agnostic `request` (polymorphic, keyed on its own `type`) | [`@agenetes/protocol`](../../external/agenetes/packages/protocol) `defineRequest`/`composeRequest`; concrete variant schemas (`huabu.selection`, …) in [packages/shared/src/types/agent](../../packages/shared/src/types/agent), registered in `apps/server` | **Not driver-owned** — a plain-data union shared across every `kind`; each variant's `render` normalizes to a uniform input; the raw request is logged verbatim ([§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)). User text rebuilt from it on reload. |
| L1 ↔ L2 | `AgentStreamEvent`             | [packages/shared/src/types/agent/agent.ts](../../packages/shared/src/types/agent/agent.ts)            | L1 renders only these; never pi-agent-core / ACP shapes.                      |
| L1 ↔ L2 | Control channel + `AgentCapabilities` | [acp/client.ts](../../apps/server/src/modules/agent/acp/client.ts) · [acp/threads.route.ts](../../apps/server/src/modules/agent/acp/threads.route.ts) *(to unify)* | ACP-client-role subset; in-process **duplex**, no sidecar; capability-gated; reverse permission = injected port; SSE+POST is the browser-wire bridge ([§3.6.2](#362-the-upward-interface--agenthandle-the-duplex-control-channel-and-capability-negotiation)). |
| L1 ↔ L2 | `CanvasCommand` / `Execution`  | [packages/shared/src/types/canvas](../../packages/shared/src/types/canvas)                            | The 14-command agent subset; validated + traced server-side.                  |
| L2 ↔ L3 | ACP (agentlet)                 | [external/agentlet/spec/protocol.md](../../external/agentlet/spec/protocol.md)                         | One ACP session per Sediment thread.                                          |
| L2 ↔ L3 | RFS endpoints                  | [packages/shared/src/types/api/rfs.ts](../../packages/shared/src/types/api/rfs.ts)                    | Plain HTTP; no client tool shipped into the agent.                            |
| L2 ↔ L3 | Agent Team manifest            | [external/agentlet/spec/agent-team.md](../../external/agentlet/spec/agent-team.md)                    | `agentlet.yaml`: `command` + `require` (cli-tools / skills / prompts).        |

**Wire-contract discipline (restated for the seams, with one carve-out).** Every seam type is defined once, validated on the server via `safeParse`, never redefined inside `apps/server` or `apps/web`, and imported into the web bundle as `import type` only (keep the bundle zod-free). **Carve-out:** the driver-agnostic L1↔L2 *protocol* primitives (the `WorkloadSpec` building blocks, the `AgentRequest`/`render` primitives, `AgentStreamEvent` mirror, `ControlMsg`, `AgentCapabilities`) live in the extractable [`@agenetes/protocol`](../../external/agenetes/packages/protocol) package rather than `packages/shared` — they are the reusable control-plane contract, not Huabu-specific wire types. Host-specific pieces (the internal driver's `spec`, e.g. `BuiltinAgentSpec`; the concrete request variant schemas, e.g. the canvas selection shape) stay under `packages/shared` and are wired in via `defineBinding` / `defineRequest`. This deviation from "wire types live in `packages/shared`" is recorded in [api-design.md](../architecture/api-design.md).

---

## 6. Extraction — what becomes reusable

The strategic payoff is that **L2 minus the RFS canvas-shape is Agenetes: a general-purpose agent control plane** that other projects could adopt. Two extractions are in play, one done and one pending:

- **agentlet** (done) — the per-node relay is already a git subtree pushed to its own upstream ([`external/agentlet`](../../external/agentlet)). It is the transport / kubelet: spawn a runtime, bridge ACP over WSS, traverse NAT. Zero AI logic, zero application knowledge.
- **Agenetes** (scaffolded, extraction pending) — the control plane that today lives inside [`apps/server/src/modules/agent/acp`](../../apps/server/src/modules/agent/acp). Its destination repo already exists and is wired in as a subtree at [`external/agenetes`](../../external/agenetes) (upstream `git@github.com:hai-team/agenetes.git`); it currently holds only placeholder files. The control-plane code is migrated in incrementally per [§7](#7-refactor--sequencing) M5–M6.

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

No big-bang. The refactor is a chain of **milestones**, each a standalone, reviewable PR that is *largely behaviour-preserving* — the running product keeps working after every one. Dependencies: **M0 → M1 → M2 → M2.5 → M2.6 → {M3, M4} → M5 → M6**; M7 is deferred. Each milestone below lists its *goal*, *deliverables*, *depends on*, and *acceptance* (what proves it done without regressions).

**M0 — Adopt the vocabulary + assert the seams.** *(This proposal's concrete deliverable.)*
- *Goal:* make the L1/L2/L3 split real in the tree and enforced by CI.
- *Deliverables:* land this doc; reference L1/L2/L3 in PR descriptions and new module headers; add lint/dependency checks (extend the existing web-layer dependency rules — see [web-architecture.md](../architecture/web-architecture.md)) so L1 code cannot import L2 internals and L3 manifests cannot import server code.
- *Depends on:* nothing.
- *Acceptance:* CI fails on upward imports; the current tree passes the new rule (after any fixes); the rule is documented.

**M1 — Freeze the L1↔L2 contracts.** *(The interface freeze — the forcing function of [§8](#8-open-questions), and the prerequisite for everything below.)* **Status: contracts authored** — the primitives now live in [`@agenetes/protocol`](../../external/agenetes/packages/protocol); wiring them into `apps/server` / `packages/shared` is M2.
- *Goal:* pin the seam as versioned, serializable types so a second L2 implementation could satisfy it unchanged.
- *Deliverables:* the driver-agnostic protocol primitives as zod schema + `z.infer` types in [`@agenetes/protocol`](../../external/agenetes/packages/protocol) ([§5](#5-inter-layer-contracts-the-seams) carve-out) — `defineBinding({ kind, spec })` + `composeWorkloadSpec({ bindings, request })` (the host composes the closed `WorkloadSpec` union keyed on the **top-level `kind`** route; each driver owns only its `spec`, [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)), `defineRequest({ type, schema, render })` + `composeRequest([...])` for the **driver-agnostic `request` union** (plain-data variants keyed on `type`; `render` normalizes each to a uniform input and is passed into `submit(request, render)`), `workloadKindSchema`, the branded `threadId`/`sessionId` ids, the driver-agnostic `AgentStreamEvent` (a thin `{ type, data }` union over the 14 event types that references the ACP SDK's own zod for ACP-shaped payloads so they cannot drift from the standard; the two host-specific fields — `meta.mode`, `tool_call.internalToolName` — are left as host extensions, not upstream), the host→agent `ControlMsg` vocabulary (a closed `{ type, data }` union — `cancel` / `set_mode` / `set_model` / `set_config_option` / `answer_permission` — symmetric with `AgentStreamEvent` on the duplex channel; the agent→host direction rides `AgentStreamEvent`, not `ControlMsg`, resolving that [§8](#8-open-questions) detail), a minimal `ControlAck`, and the composable `AgentCapabilities` descriptor (`{ control: ControlMsgType[], loadSession?, slashCommands?, turnInput }`, `turnInput` defaulting to `'blocking'`) whose `control` list is exactly the capability-granularity list; the host-specific driver `spec` (e.g. `BuiltinAgentSpec`) and the concrete request variant schemas stay in `packages/shared` and bind in via `defineBinding` / `defineRequest`; the discovery/offering catalogue shape; pin the **two-level identity contract** ([§8](#8-open-questions)): `threadId` = L1-minted caller/slot key (the only wire-addressed id), `sessionId` = L2-internal execution instance surfaced only via capability-gated query/resume, with resume as a `loadSession`-gated `Deployment` capability.
- *Depends on:* M0.
- *Acceptance:* both drivers' current behaviour is expressible in the frozen types; the server `safeParse`-validates every input; the web bundle imports them as `import type` only (stays zod-free), per [api-design.md](../architecture/api-design.md).

**M2 — Introduce `AgentHandle` (the execution seam only).** *(Behaviour-preserving abstraction.)* **Status: shipped** — `AgentHandle` + `BuiltinAgentHandle` + `AcpAgentHandle` live under [`apps/server/src/modules/agent/agenetes/`](../../apps/server/src/modules/agent/agenetes); `runAgent` / `runAcpAgent` are now thin composition shells over them; full server suite + workspace typecheck green.
- *Goal:* make the latent common interface ([§3.6.2](#362-the-upward-interface--agenthandle-the-duplex-control-channel-and-capability-negotiation)) explicit without changing behaviour — extract the **execution seam** now, defer the **factory seam** (`create(spec)` + registry) to M4/M5 when the host resources it needs are injectable.
- *Scope decision — execution seam, not factory.* The ideal in [§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) is `driver.create(spec) → handle`, which would move definition-resolution + state-rebuild into the factory (control-plane leak #4). But `create(spec)` needs its host resources injected — the built-in path reaches `getLLMModel()` / `ensureApiKey()` module singletons and `buildToolsForScope` (canvas-coupled), and the ACP path's `ensureAcpSession` directly imports ~11 host modules (spawn-orchestrator, profile/session stores, …). Turning those into injectable ports is the M4 (canvas DI) / M5 (package boundary) work; doing it in M2 would inject deep host coupling prematurely. So M2 keeps **all loading in the composition shells** (`runAgent` / `runAcpAgent`, which the route still calls unchanged) and has each shell construct the backing instance (a `new Agent({…})` for built-in; an `ensureAcpSession(…)` `entry` for ACP), then inject it — object-first — into the handle constructor (`new BuiltinAgentHandle(agent, { … })` / `new AcpAgentHandle(entry, { … })`). Leak #4 (loading → factory) is therefore **explicitly deferred**; M2 delivers only the execution seam, and the route rewire (lifting handle construction out of the shells) is likewise deferred to the M4/M5 `create(spec)` factory — the shells remain the composition layer for now.
- *Deliverables:* define `AgentHandle` — `submit(request: AgentRequest | null, render)` (data-plane in), `events(): AsyncGenerator<AgentStreamEvent, Message[]>` (data-plane out), `control(msg: ControlMsg): Promise<ControlAck>` using the M1 protocol vocabulary, and a read-only `capabilities: AgentCapabilities`. `AcpAgentHandle` wraps the shell-supplied ACP session `entry` (control verbs delegate to [`AcpAgentClient`](../../apps/server/src/modules/agent/acp/client.ts)); `BuiltinAgentHandle` wraps a shell-supplied pi-agent-core `Agent`. Land these under `apps/server/src/modules/agent/agenetes/` (the transitional location [M5](#7-refactor--sequencing) already allows; a pure relocation into `external/agenetes` once M4/M5 decouple the host ports).
- *`submit(request | null, render)` — explicit render; `null` is a driver-defined fork.* `render` is a per-turn parameter, not a driver property ([§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)): `submit` takes the plain, replayable request data (a `ChatEnvelope`) plus the composed `render`, and invokes `render` at the last moment — but only for a **non-null** request. A `null` request carries **no protocol contract**: its meaning is entirely driver-defined, and `render` is never invoked. The built-in path renders an envelope turn via `agent.prompt(rendered)` (the `Agent` is built over **history only**; `submit` renders **this turn** and appends it), and for the envelope-less callers (memory / sketch / reachback, which pre-assemble the full transcript) submits `null` and resumes via pi-agent-core's `continue()` — so `continue()` is **retained** as a built-in-internal detail, not exposed on the interface. `prompt` vs `continue` is thus a driver-internal decision keyed on whether a turn was rendered. This keeps the built-in symmetric with ACP for the normal path (`entry.client.prompt(sessionId, rendered.blocks)`) while letting each driver define its own null semantics (ACP rejects a null request with an `error` event). M2 `render` defaults to pass-through (the existing `renderEnvelopeMessages` / `prepareExternalAgentPrompt`).
- *Fold in the `AgentStreamEvent` shell (M1 acceptance ③ groundwork).* Re-derive `packages/shared`'s `AgentStreamEvent` as a thin shell over `z.infer<@agenetes/protocol schema>` plus the two host `.extend()` fields (`meta.mode`, `tool_call.internalToolName`), imported as `import type` so the web bundle stays zod-free. This is near-zero-churn: the events are structurally identical to today's hand-written union, so downstream consumers are untouched; the one wrinkle — the protocol's branded `threadId` on `meta` — is resolved by overriding it back to plain `string` in the host shell (no producer-side casts).
- *Depends on:* M1.
- *Acceptance:* `runAgent` / `runAcpAgent` are reimplemented over the handle; agent routes emit an identical `AgentStreamEvent` stream; existing tests pass. **Met:** both shells delegate to their handle (`submit` + `yield* events()`); full `apps/server` suite (277/277) and `pnpm -r typecheck` (server + web + shared) green; no route or SSE changes.

**M2.5 — Physically isolate L2 as `@agenetes/runtime` + the driver register seam.** *(Package-boundary forcing function; the empty-framework + object-injection form of the [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler) registry.)* **Status: shipped** — the host-agnostic framework now lives in [`external/agenetes/packages/runtime`](../../external/agenetes/packages/runtime); the two handle *implementations* stay in `apps/server` and are injected as driver objects; full server suite + workspace typecheck green.
- *Goal:* move the L2 *framework* (the `AgentHandle` execution seam + a driver register / dispatch seam) into a physically separate subtree package that depends ONLY on `@agenetes/protocol`, proving the layer boundary is real rather than a naming convention — without yet paying the M4/M5 cost of making the host couplings injectable.
- *Why now, before M3/M4.* M2 left `AgentHandle` in `apps/server`, so "L2" was still just a folder; nothing prevented an upward import from creeping back in. Extracting the framework into a package whose only dependency is `@agenetes/protocol` is the forcing function: the compiler now rejects any `@sediment/shared` / pi-ai / ACP / canvas leak into the framework. The trick that keeps this cheap is that **only the framework moves** — both concrete drivers keep all their host couplings and stay in the host.
- *The K8s/CRI model.* `AgentRuntime` is the runtime *framework*; `AgentDriver`s are the runtimes it dispatches to. Standard drivers (e.g. ACP) are destined to ship *inside* `@agenetes/runtime` once M4/M5 turn their host couplings (canvas capabilities, transport, translator/store) into injectable ports — the analogue of a built-in container runtime. Custom, business-coupled drivers (the canvas-coupled built-in agents) are always injected by L1. Until then, **both** are injected as objects, and the framework ships empty.
- *Deliverables:* the [`@agenetes/runtime`](../../external/agenetes/packages/runtime) package exporting the host-agnostic `AgentHandle<TRequest, TRendered, TResult, TEvent>` + `RenderFn`, and the register seam `AgentDriver` + `AgentRuntime` + `createAgentRuntime()`. `AgentHandle` gains a `TEvent` parameter (constrained to the protocol `AgentStreamEvent`, defaulting to it) so the host can bind a host-extended event union — here `InStreamEvent` (every host frame except the route-synthesized `meta` / `end`) — while the framework's yield type stays wire-level. Host side: `agenetes/handle.ts` becomes a thin binding shim (re-exports the seam; binds request = `ChatEnvelope`, result = pi-ai `Message[]`, events = `InStreamEvent`); a new `agenetes/drivers.ts` registers `builtinAgentDriver` / `acpAgentDriver` into a process-wide `agentRuntime` at module load and exposes `getBuiltinDriver()` / `getAcpDriver()`; the `runAgent` / `runAcpAgent` shells now `resolve(kind).create(input)` instead of `new XxxHandle(...)` (the route fork is unchanged).
- *Depends on:* M2.
- *Acceptance:* `@agenetes/runtime` depends only on `@agenetes/protocol` and builds standalone; the driver implementations satisfy the framework contracts unchanged; the route fork and SSE stream are unchanged; full `apps/server` suite + `pnpm -r typecheck` green. **Met.**

**M2.6 — Correct the handle lifecycle (Job = one-shot run · Deployment = long-lived session) + L2 `create` / `get`.** *(Corrects M2's Job-shaped handle; the control-plane lifecycle layer M3 builds on.)* **Status: next.**
- *Why — M2 mis-modelled the handle as per-turn.* M2's `events(): AsyncGenerator<…, Message[]>` makes "the generator completing = one turn ending, returning that turn's `Message[]`" — a one-shot **Job** shape — so the shell creates a fresh handle per turn and discards it. That is correct for a **Job** but wrong for a **Deployment** ([§3.2](#32-workload-kinds-job-vs-deployment)): an ACP session is a long-lived, stateful connection that hosts many turns, carries cross-turn `control`, emits out-of-turn notifications, and has a **liveness** dimension (`active` → `closed` on explicit teardown / `dropped` on connection loss) a Job never has. Forcing the Deployment through a per-turn handle is exactly what left `control()` homeless (the REST routes bypass the handle and reach into `entry.client`), the out-of-turn `available_commands_update` with nowhere to land (cached + `GET`-polled), and the only cross-turn-live object as the ACP-specific `AcpSessionEntry` rather than our own handle abstraction.
- *Two orthogonal axes, kept separate.* M2's per-turn shape conflated **lifecycle** (one-shot vs long-lived) with **control richness** (which `control` ops / facets — [§3.6.2](#362-the-upward-interface--agenthandle-the-duplex-control-channel-and-capability-negotiation)). §3.6.2 only cut along control richness; M2 wrongly imposed one-shot lifecycle on *everyone*. M2.6 fixes the **lifecycle** axis; the `meta`/`end` brackets stay L1-synthesized around each run (that M2 call was right — they are the per-turn brackets inside a session's continuous stream).
- *One base + Deployment adds a layer.* A **run/turn** — `submit(request | null, render) → AsyncGenerator<AgentStreamEvent, Message[]>` — is the unit both kinds share. A **Job** *is* exactly one run then terminal (its handle's life == the run; essentially a function call). A **Deployment** *has-a* run-producer: a long-lived session that hosts many runs plus `control()` / notifications / `capabilities` / liveness / `close()`. Deployment is the base + a session layer; Job is the degenerate one-shot. This is the ACP client role's own shape (a long-lived client + a per-turn `prompt` call).
- *L2 owns handle lifecycle — two imperative primitives, not declarative reconcile.* `AgentRuntime` grows from M2.5's driver dispatch table into a lifecycle owner that holds live Deployment handles keyed by `threadId` (the L1-minted addressable id — the identity contract of [M1](#7-refactor--sequencing) / [§8](#8-open-questions)), generalising today's `ensureAcpSession` (get-or-create-by-threadId + inflight-dedup + drop→`shutdown()`):
  - `get(threadId): handle | undefined` — pure lookup, **no spec**, never creates. Retires the wart where the control routes drag `{profileId, canvasId, cwd}` around merely to *find* a session to set its mode: they become `get(threadId).control(setMode)`, and a missing session is a precondition failure (correct — do not lazily spawn a session just to set a mode).
  - `create(threadId, spec): handle` — constructs + registers the live handle; **spec is used only at construction**; get-or-create by identity (reuse if already live, collapsing the concurrent-first-call race as `ensureAcpSession` already does). It deliberately **does not reconcile spec drift** — a declarative `apply(spec)` would owe a spec-diff plus a "what does a changed spec mean (restart? reconfigure?)" policy we do not need yet. Changing the spec is an **explicit `close()` + `create()`** the caller decides, not a hidden reconcile. (This matches `ensureAcpSession`'s current reuse-ignores-spec behaviour — zero behaviour drift.)
  - Job: never enters the registry — each invocation is a fresh one-shot run, so `get(threadId)` is always `undefined` for a Job.
- *Not a scheduler, not a reconciler ([§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)).* Imperative `create` / `get` / `close` of one named workload per `threadId` is lifecycle ownership — no queue, no placement, no replicas, and (by choosing `create` over `apply`) no desired-state reconcile loop. The line M2.5 drew holds, and we avoid taking on reconcile complexity prematurely.
- *Host imports stay in the driver.* `ensureAcpSession`'s ~11 host imports stay inside the ACP driver (host side); L2 only calls the driver's construction + lifecycle hooks and stays protocol-only — consistent with M2.5's custom/standard-driver-injected model.
- *Depends on:* M2.5.
- *Acceptance:* the Deployment handle survives across turns until `close()` / drop; `AgentRuntime` exposes `create(threadId, spec)` / `get(threadId)` keyed by `threadId`; the Job path stays one-shot; the control routes resolve the handle via `get` (carry no spec); behaviour otherwise preserved; full `apps/server` suite + `pnpm -r typecheck` green.

**M3 — Home control + notifications on the long-lived Deployment handle.** *(What remains of the original "one control channel" once M2 / M2.6 land.)*
- *Goal:* now that the `control(msg)` + `capabilities` vocabulary (shipped in M2) has a correct home (the long-lived handle, M2.6), route the ACP-shaped REST side-band through it and give out-of-turn agent→host pushes a home ([§3.6.2](#362-the-upward-interface--agenthandle-the-duplex-control-channel-and-capability-negotiation)).
- *Deliverables:* fold `/acp/threads/:t/{mode,model,commands,permission}` into `get(threadId).control(...)` (leaks #1–#3); reverse permission stays a duplex correlated by `requestId` — already the shape (`answer_permission` control ⟂ `permission_request` event), so the "injected port" is a reframing, not new work; expose agent→host out-of-turn notifications (`available_commands_update`, `current_mode_update`) on a handle-level `notifications()` stream instead of the cached-snapshot + `GET`-poll. Keep the browser hop as the SSE↓ + POST↑ bridge — that is L1's own transport, **not** part of the L1↔L2 seam (a standing browser channel is M6).
- *Depends on:* M2.6.
- *Acceptance:* permission / mode / slash flows work end-to-end through `handle.control` / `notifications` resolved via `get(threadId)`; the control REST routes carry no spec; UI unchanged or minimally adapted; tests pass.

**M4 — Extract the standard (ACP) driver's host ports.** *(Re-scoped: the real "make a driver relocatable" work; the built-in stays a host-injected custom driver.)*
- *Goal:* turn the ACP (standard) driver's host couplings — `ensureAcpSession`'s ~11 host imports (spawn-orchestrator, profile/session stores, transport, translator) — into injectable **ports**, so the standard driver can eventually ship *inside* `@agenetes/runtime` (M2.5's K8s/CRI end-state).
- *Why the original canvas DI is demoted.* The original M4 ("remove `modules/agent`'s `canvas-executor` import") is largely moot after M2.5: `canvas-executor` is imported only by [`canvas-write.ts`](../../apps/server/src/modules/agent/tools/handlers/canvas-write.ts), an **L1-owned built-in tool**, not by `agenetes/` or `@agenetes/runtime` — L2 is already canvas-free. And the built-in agent is a **custom, L1-injected driver** that *stays in the host* (K8s/CRI model), so its static `canvas-executor` import is legitimate, not a layer violation. Injecting a `canvasPort` is now only a *flexibility / testability* option, not a layering necessity — demoted to optional.
- *Deliverables:* define the ACP driver's ports (transport / session-open / translator / store) as injected interfaces; the driver depends on the ports, the host supplies the impls; optionally the built-in `canvasPort` injection if the flexibility is wanted.
- *Depends on:* M2.6.
- *Acceptance:* the ACP driver names no host module directly (only ports); the host injects the impls; behaviour unchanged; the seam lint (M0) proves the arrow is L1→L2; tests pass.

**M5 — Name the Agenetes package boundary.**
- *Goal:* make the four dimensions and the extraction seam visible in the tree.
- *Deliverables:* group the definition/lifecycle/communication/persistence stores under the Agenetes package — scaffolded at [`external/agenetes`](../../external/agenetes) (or, transitionally, `modules/agent/agenetes`) — with workload kinds ([§3.2](#32-workload-kinds-job-vs-deployment)) as first-class types and transport as a pluggable ARI ([§3.1](#31-the-transport-axis-why-it-is-separate)); make `WorkloadSpec` fully serializable; drop `canvasId` from `loadTurns` (identity cleanup, per M1's `threadId` decision); optionally relocate `intent` to an L1-owned module (cosmetic, [§8](#8-open-questions)).
- *Depends on:* M3, M4.
- *Acceptance:* the tree reflects the four dimensions; seam lint stays green; behaviour unchanged.

**M6 — Re-split `@agentlet/server` + lower-seam lifecycle ARI.**
- *Goal:* leave transport in `@agentlet/server`, move the control plane into Agenetes.
- *Deliverables:* move the control-plane half (session/event stores, lifecycle types, session REST) into Agenetes per the [§6.1](#61-re-splitting-agentletserver-transport-vs-control-plane) table; make `spawn`/`stop`/`suspend` the distinct Agenetes↔agentlet ARI contract ([§8](#8-open-questions) decision). Touches the `external/agentlet` and `external/agenetes` subtrees — commit each separately for clean upstream push ([§6.2](#62-subtree-maintenance)).
- *Depends on:* M5.
- *Acceptance:* transport/control split matches [§6.1](#61-re-splitting-agentletserver-transport-vs-control-plane); subtree commits are clean for upstream; behaviour unchanged.

**M7 — Generalise the RFS resource shape.** *(Deferred.)*
- *Goal:* let a non-canvas resource plug in behind the RFS verbs.
- *Deliverables:* a host-defined resource schema behind RFS.
- *Depends on:* M5; **pursue only when a real second consumer / second L2 appears** ([§8](#8-open-questions)).
- *Acceptance:* a second resource kind round-trips through RFS without L2 changes.

---

## 8. Open questions

- **`intent` ranking placement — settled: L1, cosmetic.** Intent ranking is an L1 sense-making function (it decides *which* context and *what* the user likely means — a semantic decision L1 owns; L2 at most does rule-based transforms of already-selected context via a handle callback). It is *physically* under `modules/agent` today only for proximity to the shared context-assembly code, but context assembly is itself L1. There is **no blocking issue** either way: intent can even be modelled as a program-initiated zero-tool `Job` ([§3.2](#32-workload-kinds-job-vs-deployment) — the initiator need not be human) and nothing breaks. So this is a low-risk, optional file relocation at refactor time ([§7](#7-refactor--sequencing) M5), not an open design question.
- **Extracting the built-in (SDK) driver: which decoupling, and does it migrate onto ACP?** [§3.4](#34-control-plane-vs-data-plane-and-where-session-state-lives) leaves the SDK driver serving only `Job`s. [§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) reframes the extraction crux from a binary into **three options** for the built-in tools' in-process `import` of `canvas-executor`:
  1. **(a) status quo** — hard `import`, harness fused with L1: fast, but not module-decoupled or extractable.
  2. **(b) RFS-ify the tools** — canvas access goes out-of-band: fully decoupled and remotable, but pays per-call serialization.
  3. **(c) dependency-inject an in-process canvas port** — removes the compile-time coupling while keeping the call in-process: module-decoupled *and* fast, but remotable only by later swapping the port for a remote adapter.
  *Decision: (c).* [§3.6.2](#362-the-upward-interface--agenthandle-the-duplex-control-channel-and-capability-negotiation) makes "inject an in-process host capability port at registration" the general idiom (the reverse permission `onPermissionRequest` port works exactly this way), so `canvasPort` (c) is that same idiom rather than a special case. (b) is rejected by the same logic that rejects an in-process ACP loopback — it pre-buys remotability/serialization the built-in does not need; and [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)'s "a driver *is* its resource" makes the built-in being in-process-only a design fact, not a limitation (going remote = swap the port for a remote adapter, i.e. become a different binding). (b) is warranted only if a built-in must run in its own process.
  **Migrate built-ins onto ACP? — default no.** Since built-ins serve the `Job` subset and have a different threat model (a trusted in-process harness gated by admission + the change-review card, so no `request_permission`), the default is to keep the SDK driver as a stateless-Job runtime. Move *one* built-in onto the ACP driver only when *it specifically* needs a rich `Deployment` (in-process modes / slash / state); the [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler) `external`-alias indirection makes that a per-agent, one-line re-wire, not a blanket migration.
- **One shared `Job` control surface?** A Job's control plane is submit + cancel on both drivers ([§3.2](#32-workload-kinds-job-vs-deployment)). *Resolved by [§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) (decision B) and [§3.6.2](#362-the-upward-interface--agenthandle-the-duplex-control-channel-and-capability-negotiation):* Agenetes defines its own minimal control vocabulary (an ACP-client-role subset) over one in-process **duplex** channel — so the reverse permission request is a host-implemented method (injected port), not a side-band, and the "pure-SSE can't answer a reverse RPC" gap exists only on the browser wire (already bridged by SSE-event + POST, upgradeable to WebSocket without touching L2). `AgentCapabilities` is likewise settled in shape: a composable, open descriptor negotiated in two phases (candidacy at register / actual at create). *The field-level schema is now authored in [`@agenetes/protocol`](../../external/agenetes/packages/protocol):* `ControlMsg` is the closed host→agent `{ type, data }` union (`cancel` / `set_mode` / `set_model` / `set_config_option` / `answer_permission`), and the capability-granularity list is exactly `AgentCapabilities.control: ControlMsgType[]` plus the `loadSession` / `slashCommands` / `turnInput` fields — so `configOptions` is one capability (`set_config_option`) carrying an `optionId`, not one capability per option.
- **Control-plane relocation (from the [§3.7](#37-walkthroughs--the-model-against-todays-code) dry runs).** The seam works today but leaks: (1) there is no single serializable `WorkloadSpec` — it is assembled from `agentBinding` + a server-side profile lookup; (2) control ops are side-band, ACP-shaped REST routes (`/acp/threads/:t/{mode,model,commands,permission}`) exposed straight to L1, rather than one Huabu-owned `control()` channel; (3) out-of-turn pushes (`available_commands_update`) are REST-polled instead of stream-delivered; (4) for the built-in driver, definition resolution + state rebuild happen in the *route*, not inside `create(spec)`. Folding these into the [§3.6](#36-the-l1l2-binding-an-in-process-ari-handle-modelled-on-the-acp-client-role) handle model is a [§7](#7-refactor--sequencing) refactor, largely behaviour-preserving. The *target* shape is now settled — one in-process duplex `control()` channel with the [§3.6.2](#362-the-upward-interface--agenthandle-the-duplex-control-channel-and-capability-negotiation) vocabulary; these four are the remaining mechanical relocations onto it.
- **Residual `canvasId` coupling in the turn log.** [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler) settles that `threadId` alone is the slot key — and the ACP session key (`threadKey`) already ignores `canvasId` — but the built-in turn log is still loaded as `loadTurns(threadId, canvasId)`. Dropping the `canvasId` argument (relying on `threadId`'s global uniqueness) would align persistence with the addressing model and remove a canvas leak from L2's store. This is a mechanical cleanup ([§7](#7-refactor--sequencing) M5), not a design question.
- **Caller identity vs execution identity — resolved (the `metadata.name` vs `uid` split).** The seam uses **two** identities at different layers, and neither is open any more:
  - **`threadId` — the caller/slot identity, L1-minted.** Stable, client-supplied (idempotency-key style, as today), the *only* id the L1↔L2 wire contract addresses. It is the K8s `metadata.name`: it names *the slot*, not an execution. L2 treats it opaque; everything it *represents* (canvas / node / user) is held by L1 and indexed by it ([§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler)).
  - **`sessionId` — the execution-instance identity, L2-internal.** One concrete agent execution / live process backing the slot (the ACP `session/new` result, [`client.ts`](../../apps/server/src/modules/agent/acp/client.ts)) — the K8s `uid` / pod. A `threadId` maps to **0..N** `sessionId`s over its lifetime (fresh one per execution or resume). It is **not** an L1↔L2 addressing field; it surfaces only through capability-gated query / resume. **We keep the name `sessionId`** — "session" is the industry-standard harness term for exactly this lower-level instance concept, which is *also* why the workload kind was renamed `Session → Deployment` ([§3.2](#32-workload-kinds-job-vs-deployment)) to free it up.
  - **Resume is a driver capability, not a universal guarantee.** Reattaching to a prior `sessionId` is the `loadSession`-gated ability a stateful `Deployment` driver advertises at `initialize` ([§3.4](#34-control-plane-vs-data-plane-and-where-session-state-lives)); a `Job` need not have it. The built-in driver's current trick of *rebuilding* context from the on-disk turn log is **host-side compensation**, not a driver-native session — a distinction to preserve, but one that does not affect the interface (future refinement, [§7](#7-refactor--sequencing)).
- **How does L1 select an agent — and how is that not "naming a driver"?** *Resolved by [§3.6.1](#361-dispatch-driver-affinity-discovery--and-why-l2-is-not-a-scheduler):* L1 **does** name its driver — but via the top-level, contract-owned **route** `kind` (`internal`/`external`), never L2's impl identifier (`acp`/`sdk`). This is the deliberate break from Kubernetes: we are a **conduit, not a scheduler** — the caller knows exactly which non-fungible driver it wants (each driver *is* a pinned resource), so `kind` is a required public discriminant, not a scheduling hint. L2 resolves `kind` against a driver registry (deterministic, no scoring), gated by admission; a mechanism-free discovery catalogue exposes offerings + capabilities (never impl names). Open sub-parts: the concrete registry/discovery API surface, and whether a `kind` may ever fan out to more than one driver class.
- **Are built-in agents an L2/L3 concern, or L1's?** *Resolved: L1-owned.* `ask`/`operate`/`sketch` are the canvas's **first-party native agents** — canvas-coupled prompts/skills/tools, tuned as product experience — so their ownership is **L1**, not L3 (IDE analogy: built-in IntelliSense is part of the IDE; L3 is the plugin marketplace, [§2](#2-layer-1--human-ai-interface-hai--interaction-driven)/[§4](#4-layer-3--task-automation--task-driven)). L2 owns only the **execution mechanism**: L1 injects a **built-in driver factory** (closing over the prompt + tools + `canvasPort` impl) into L2's driver registry, so the dependency arrow stays L1→L2 and L2 never imports canvas code — the whole-driver form of the option (c) port injection above. This *widens L1's boundary* from pure interface/transport to **interface + first-party intelligence** — an accepted, explicit expansion. Migrating a built-in onto ACP is then a deliberate re-homing (L1-native → L3 plugin), not a path swap (dovetails with "migrate built-ins onto ACP? — default no" above). Residual: the `prompt/agents` loader co-location under `apps/server` is a monorepo accident ([§3.5](#35-the-agent-definition-content-vs-mechanism-and-how-tools-bind)); whether to relocate the *content* out of the server is a follow-up. (The `Job`/`Deployment` split from [§3.2](#32-workload-kinds-job-vs-deployment) stays orthogonal — an L1-native agent can be either kind.)
- Do the `spawn`/`stop`/`suspend` control verbs stay in [`@agentlet/protocol`](../../external/agentlet/packages/protocol), or become a distinct Agenetes↔agentlet ARI contract once the control plane is extracted? ([§6.1](#61-re-splitting-agentletserver-transport-vs-control-plane).) *Decision: the lower ARI.* These are class-1 **lifecycle** verbs (implicit reconcile — lazy spawn / idle-suspend / resume), which the [§3.1](#31-the-transport-axis-why-it-is-separate) topology places on the **Agenetes↔agentlet** seam, distinct from the L1↔L2 `control()` channel ([§3.6.2](#362-the-upward-interface--agenthandle-the-duplex-control-channel-and-capability-negotiation)) that carries the class-2 pass-through verbs (setMode / cancel / permission). They become their own lower-seam contract; the exact packaging lands when the control plane is extracted ([§7](#7-refactor--sequencing) M6).
- **What forces the extraction to be real — a second consumer, or a second L2?** There is no second consuming project today. The forcing function is instead the prospect of **alternate L2 implementations** — a different transport protocol or agent framework behind the *same* L1↔L2 contract. So the goal is to **freeze the L1↔L2 interface** (`WorkloadSpec` / `AgentRequest` / `AgentStreamEvent` / the `control()` channel + `AgentCapabilities`) well enough that a second L2 impl could satisfy it unchanged — the **stable interface**, not a second app, is what validates the layering.
- **Multi-user real-time co-editing — out of scope.** Whether real-time multi-user co-editing ([canvas-realtime-sync-plan.md](./canvas-realtime-sync-plan.md)) needs an L2 notion of "presence" is **explicitly a non-goal** for this proposal; single-user interaction is assumed throughout. Revisit only if/when concurrent human+agent co-editing becomes a requirement.

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
- [web-architecture.md](../architecture/web-architecture.md) — L1 dependency rules (the template for [§7](#7-refactor--sequencing) M0 seam lint).
- [agent-reachback-rfs.md](./agent-reachback-rfs.md) — the RFS seam (L2↔L3 reachback).
