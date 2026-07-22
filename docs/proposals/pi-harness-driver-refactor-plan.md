# Pi Harness Standard Driver and Huabu Built-in Agent Refactor

> Turn the current Huabu built-in pi-agent-core path from a per-turn replay workaround into a conversation-native Agenetes standard driver.
>
> Status: **Shipped** · Last updated 2026-07-11

---

## 1. Context

Agenetes now has a clearer positioning: it is an aggregating control plane for agents across environments, not a full agent-hosting platform, and its driver model is defined by binding schema, runtime protocol, and transport.

The original Huabu built-in agent path predates that model and ran multi-turn chat as a threaded Job workaround: every turn rebuilt a fresh `@earendil-works/pi-agent-core` `Agent`, reconstructed the prior pi message array from durable history, appended the current request, streamed the answer, and let Agenetes fold the emitted events back into history.

That shape was useful during the rush to unify built-in and external agents behind Agenetes, but it was never the target architecture. Interactive multi-turn conversations should be conversation-native Deployments: one durable `threadId` owns one long-lived runtime handle, normal turns continue the live harness state, and durable history is used for UI rendering and tail reconnect rather than for routine per-turn context reconstruction.

This proposal scoped the standard pi harness driver and the Huabu-side refactor that migrated built-in agents onto it. The driver, Deployment cutover, Agenetes-managed restart recovery, and content-triggered `set_context` synchronization have shipped.

## 2. Goals

1. Ship a standard Agenetes pi harness driver that wraps pi-agent-core behind the shared `AgentHandle` contract.
2. Make interactive built-in conversations use Deployment semantics with a long-lived pi `Agent` per `threadId`.
3. Keep Huabu-specific profile content, canvas tools, request rendering, model/account configuration, and workspace/canvas memory outside the standard driver.
4. Remove routine per-turn transcript replay from the Huabu built-in chat path.
5. Preserve the per-request render insight while allowing fallback renderers.
6. Update Agenetes invariants where the current README still reflects the legacy fresh-Job built-in path.

## 3. Non-goals

This proposal does not turn Agenetes into a model-provider abstraction, credential vault, hosted agent platform, scheduler, sandbox, multi-tenant runtime, or fleet orchestrator.

This proposal does not move Huabu agent profiles into Agenetes. Profiles remain host-owned catalog entries that compile into driver-specific workload specs.

This proposal does not require the first milestone to support remote pi harness execution. The initial transport is in-process function calls; remote transport can be designed later if the same driver contract proves stable.

## 4. Current code shape

| File/dir                                                                                                         | Current responsibility                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [apps/server/src/modules/agent/agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts)               | Chat route dispatches built-in vs ACP and supplies current host policy/request data; durable recovery and fork realization are owned below the route by Agenetes and its drivers.       |
| [apps/server/src/modules/agent/agent.service.ts](../../apps/server/src/modules/agent/agent.service.ts)           | Composition shell that compiles the built-in request into a serializable pi workload spec, drives `runAgent`, and synchronizes changed Deployment system prompts through `set_context`. |
| [apps/server/src/modules/agent/agenetes/drivers.ts](../../apps/server/src/modules/agent/agenetes/drivers.ts)     | Host-owned registration layer that mounts the standard ACP and pi drivers and binds Huabu contract kinds to them.                                                                       |
| [apps/server/src/modules/agent/agenetes/pi-driver.ts](../../apps/server/src/modules/agent/agenetes/pi-driver.ts) | Huabu adapter that wires host model, credential, and tool ports into the standard pi driver and compiles built-in profiles into `PiWorkloadSpec`.                                       |
| [external/agenetes/packages/pi-driver](../../external/agenetes/packages/pi-driver)                               | Standard in-process pi-agent-core driver package used by both Job and Deployment lifecycles.                                                                                            |
| [apps/server/src/prompt/agents](../../apps/server/src/prompt/agents)                                             | Huabu-owned agent profile content: frontmatter, system prompts, tools, skill scope, and runtime defaults.                                                                               |
| [apps/server/src/modules/agent/tools](../../apps/server/src/modules/agent/tools)                                 | Huabu-owned tool definitions and executable tool bindings.                                                                                                                              |
| [apps/server/src/modules/agent/llm.ts](../../apps/server/src/modules/agent/llm.ts)                               | Huabu-owned provider/account/OAuth settings and pi-ai model construction.                                                                                                               |

The key split is now explicit: the reusable pi harness runtime and driver-specific history loading live below the host route, while Huabu-specific provider, tool, request, and target-spec compilation remain in the host adapter/composition layer.

## 5. Target architecture

```text
Huabu profile/catalog layer
  AGENT.md + workspace memory + canvas context + provider settings
      │ compiles serializable recipe + opaque host context
      ▼
Agenetes instance
  create(spec) / get(threadId) / close(threadId)
      │ dispatch by spec.kind
      ▼
@agenetes/pi-driver
  PiAgentHandle implements AgentHandle over pi-agent-core
      │ uses mount-time ports for code extension
      ▼
pi-agent-core Agent
  long-lived state.messages, tools, model, control, events
```

The driver is standard because it is shipped inside the Agenetes package set and understands the pi-agent-core harness contract. The driver is not Huabu-specific because every host-specific behavior enters through serializable recipe fields or mount-time registered ports.

## 6. Driver ownership model

The most important boundary is that the pi driver is a pi-agent-core harness driver, not an LLM-provider platform driver.

The driver should understand how to construct and drive a pi-agent-core `Agent`: system prompt, pi messages, model object, tools, API-key callback, tool execution policy, abort, event subscription, and transcript delta extraction.

The driver should not own provider accounts, OAuth refresh, Huabu settings, canvas tools, AGENT.md parsing, skill catalogue rendering, workspace memory, or request variants.

| Concern                                        | Owner                                          | Why                                                                                         |
| ---------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| pi-agent-core `Agent` lifecycle                | pi driver                                      | This is the driver runtime protocol.                                                        |
| `AgentEvent` to `AgentStreamEvent` translation | pi driver                                      | This is the anti-corruption wrapper from pi native events to Agenetes events.               |
| `PiModelRef` schema                            | pi driver or pi protocol package               | The driver needs a durable create-time way to say which pi model is requested.              |
| `PiModelRef` resolution to pi-ai `Model<Api>`  | mount-time port                                | Provider catalog, local settings, OAuth, and account policy are host-specific.              |
| API key refresh                                | mount-time port                                | It depends on host credential policy and may need per-call refresh.                         |
| executable tools                               | mount-time port                                | Tool implementations are code extension, not serializable customization.                    |
| tool refs and tool policy                      | serializable spec                              | A profile can durably declare which pre-registered capabilities it requests.                |
| request rendering                              | request variant / host renderer, with fallback | Request semantics are host-owned, but generic fallback can handle safe plain-text requests. |
| profile loading                                | host                                           | Profiles are content/defaults/catalog entries, not drivers.                                 |
| durable thread history                         | Agenetes instance                              | The log is framework infrastructure; the driver only emits observable facts.                |

## 7. Proposed driver factory API

```ts
export interface PiDriverPorts<TRequest = unknown> {
  resolveModel(ref: PiModelRef, ctx: PiModelContext): Promise<Model<Api>>;
  getApiKey(ref: PiModelRef, ctx: PiModelContext): Promise<string>;
  resolveTools(refs: PiToolRef[], ctx: PiToolContext): Promise<AgentTool[]>;
  renderFallback?: PiRequestRenderer<TRequest>;
}

export interface PiDriverFactoryConfig<TRequest = unknown> {
  ports: PiDriverPorts<TRequest>;
}

export function piDriverFactory<TRequest = unknown>(
  config: PiDriverFactoryConfig<TRequest>,
): AgentDriver<PiWorkloadSpec, TRequest, PiRenderedInput, PiRunResult>;
```

The package exports an I9.5 driver factory, not an ad-hoc driver constructor. The mounted instance installs it through the same factory dictionary used by other drivers:

```ts
const agenetes = mountAgenetes()
  .addFactory('pi', piDriverFactory)
  .register('internal', 'pi', { ports })
  .build();
```

`"pi"` is the implementation factory name; `"internal"` is an example contract `kind` chosen by the host application. The driver object itself carries no `kind`. The package API accepts ports at mount time through `factoryArgs`. Per-create inputs remain serializable `WorkloadSpec` data, so behavior extension happens by factory registration and data customization happens by spec.

There are two separate bootstrap choices here. Adding a factory makes an implementation available; registering a driver binds a host contract `kind` to one available factory. A host should always explicitly register the contract kinds it exposes, because those names are part of its persisted workload contract. It should not necessarily have to call `addFactory` for every standard factory by hand if a higher-level Agenetes assembly package or preset can preinstall standard factories in the builder. The current core `@agenetes/agenetes` package deliberately does not do that because it depends only on `@agenetes/protocol` and `@agenetes/runtime`; importing standard drivers such as ACP or pi would change its dependency boundary. A future convenience entry point can pre-add standard factories while still requiring explicit `.register(...)` calls.

`resolveModel` and `getApiKey` are separate on purpose. The model object is a pi-agent-core runtime requirement, but credentials are frequently short-lived and may need refresh before every LLM call. Huabu's current `ensureApiKey()` already has that shape. With a symbolic `PiModelRef` such as `{ type: 'host', id: 'active' }`, `resolveModel` may also be invoked again at turn boundaries so a live Deployment can track host policy changes without recreating the handle.

`renderFallback` is optional and does not replace `run(request, render, ctx)`. The per-run renderer remains the primary request-render seam. A fallback port only exists for simple hosts or safe plain-text requests when the composed renderer cannot handle a request variant.

## 8. Proposed binding schema

```ts
type PiModelRef = {
  /**
   * Host-managed symbolic model selector. The driver does not interpret the
   * id; it passes the ref to `resolveModel` / `getApiKey`.
   *
   * Examples:
   *   { type: "host", id: "active" }   // Huabu first milestone
   *   { type: "host", id: "fast" }     // future host-defined profile
   */
  type: 'host';
  id: string;
  options?: JsonObject;
};

type PiToolRef = {
  name: string;
  options?: JsonObject;
};

type PiWorkloadSpec = {
  kind: 'pi';
  workloadType: 'Deployment' | 'Job';
  namespace: Namespace;
  threadId?: ThreadId;
  spec: {
    recipe: {
      systemPrompt?: string;
      model: PiModelRef;
      tools?: PiToolRef[];
      runtime?: {
        maxIterations?: number;
        toolExecution?: 'parallel' | 'sequential';
      };
    };
    initialMessages?: Message[];
    hostContext?: JsonObject;
  };
};
```

`hostContext` is intentionally opaque to the standard driver. Huabu can place a canvas id, origin stamp, profile id, or other routing facts there, and the driver only passes it back to registered ports.

`initialMessages` is the create-time transcript seed. It is not part of the reusable profile recipe; it is the serializable state input that lets the host do a Job-first cutover without changing its current history assembly model. A live Deployment usually seeds this once, then mutates `agent.state.messages` in memory across turns.

The first milestone should keep `PiModelRef` **symbolic and host-managed**, not a serialized pi-ai `Model<Api>` and not a provider/model/baseUrl tuple. The concrete pi-ai `Model<Api>` is a runtime object with many transport- and provider-specific fields (`api`, `baseUrl`, `headers`, `compat`, cost metadata, etc.), while today's Huabu built-in path does not let AGENT profiles choose a provider/model at all — it simply uses the host's current active LLM config (`getLLMModel()` / `ensureApiKey()`). So the minimal durable contract is an opaque host selector that registered ports resolve into the live pi-ai model and credential policy.

For Huabu's first milestone the selector should simply be `{ type: "host", id: "active" }`, preserving current semantics. If the host later wants named model policies (`fast`, `best`, `reasoning`, per-agent defaults, …), those remain host-defined ids interpreted only by the ports. A future cross-host proposal can still add an explicit provider/model branch if a genuine standard use case emerges; it is not needed to ship the first standard pi driver.

## 9. Runtime behavior

For `workloadType: "Deployment"`, `create(spec)` creates or reuses one `PiAgentHandle` for `threadId`. The handle owns the long-lived pi `Agent` and treats each `run(request, render, ctx)` as a turn submitted to that live harness.

Before each turn, the handle may re-resolve symbolic recipe members that represent host policy rather than driver-owned mutable state. In Huabu's first milestone that specifically means `recipe.model = { type: "host", id: "active" }`: before `prompt()` / `continue()`, the handle resolves the current host-selected pi model and assigns `agent.state.model`. This preserves today's semantics where changing the host's active LLM configuration affects the next built-in turn, without forcing the protocol to serialize provider-specific model objects.

For `workloadType: "Job"`, `create(spec)` creates a transient `PiAgentHandle` and a transient pi `Agent` for exactly one run. This is still useful for pipeline-style workloads, evaluations, tests, and programmatic one-shot tasks.

The normal Deployment path should not rebuild `state.messages` from history on every turn. It should initialize once and continue from live pi state. If the live state is missing after process restart or explicit teardown, robust rehydration is a driver-agnostic Agenetes backlog item rather than part of this pi-driver migration.

### 9.1. pi-agent-core capabilities relevant to Deployment (verified)

The behavior guarantees a Deployment handle relies on are confirmed against `@earendil-works/pi-agent-core@0.75.5` (`dist/agent.js`, `dist/types.d.ts`):

- **Long-lived live state exists.** `AgentState` exposes `messages`, `tools`, `systemPrompt`, `model`, and `thinkingLevel` as settable accessors ("model used for future turns", "system prompt sent with each model request"). The handle can hold one `Agent`, append turns, and reconfigure it in place without minting a fresh instance.
- **Concurrent turns are rejected, not queued implicitly.** `prompt()` and `continue()` throw `"Agent is already processing…"` when a run is active. The handle must serialize turns per `threadId` (reject overlap, or use the built-in `steer()` / `followUp()` queues). This is a hard, well-defined contract.
- **In-turn abort is supported.** `abort()` cancels the active run's `AbortController`; the existing built-in handle already maps `control('cancel')` onto it.
- **Subscription is per-run-safe.** `subscribe(listener)` returns an unsubscribe; the current handle subscribes and unsubscribes around each `run`, which is valid to repeat over a long-lived `Agent`.
- **Reconfiguration is possible in place.** Because `state.model` / `state.tools` / `state.systemPrompt` are live setters, `set_model` / tool refresh / prompt refresh are mechanically feasible on a live handle; the driver still chooses which of these it advertises as control capabilities (see §12).

Conclusion: pi-agent-core is Deployment-capable. Original open question 2 (behavior guarantees) is answered by code and is no longer a coding blocker.

### 9.2. Per-turn recomputed context is not only the transcript

The legacy per-turn rebuild in `resumeThreadContext` re-derived more than history on every turn: it re-rendered the agent system prompt so `{{skillCatalogue}}` reflected freshly written user skills, and it re-appended the `<workspace_memory>` block from `readWorkspaceMemory()`. Both previously rode `spec.systemPrompt` into a fresh `Agent` each turn.

This recomputed content genuinely can change within one conversation, because the built-in `write` tool (`tools/definitions.ts`) targets `memory/workspace.md`, `memory/canvas.md`, and `skills/<id>/SKILL.md`. So a Deployment must not silently freeze the skill catalogue and workspace memory after create. Two facts settle the mechanism:

- pi-agent-core reads `state.systemPrompt` fresh at the start of every run (`createContextSnapshot`, verified in §9.1), so the system prompt can be updated between turns without recreating the `Agent`.
- Refreshing the prompt is a **live host-initiated imperative**, not a create-time or ambient trait. It therefore belongs in the control plane as a control message, not as a behavioural boolean (see §12.1/§12.4): the host compares the fully rendered prompt with the last prompt applied to the live handle and sends `set_context` only when the content differs. This content comparison catches canonical memory/skill writes as well as direct user edits without coupling prompt synchronization to individual write paths. The driver applies the update by assigning `agent.state.systemPrompt`.

This removes the unconditional per-turn control update while preserving refresh exactly when rendered content changes. A newly created Deployment already receives the current prompt through its spec; a recovered handle is synchronized once before its first turn because persisted Deployment specs remain authoritative during realization and may contain an older prompt.

## 10. Request rendering model

Per-request rendering remains the primary model because request variants own their semantics. A canvas selection, a slash-style command, a natural-language prompt, and a structured workflow request should not be flattened by the driver before the host has interpreted them.

The renderer resolution chain should be explicit:

```text
request-variant renderer
  -> host-registered renderer for request.type
  -> driver-registered generic renderer
  -> default text renderer only for safe plain-text request shapes
```

The fallback chain preserves the insight in Agenetes I6 while making simple hosts easier to integrate. A fallback renderer must never infer host-specific meaning from opaque request data. In the first Huabu migration, the existing per-run renderer remains the primary path; driver-level fallback is optional and should not block the Deployment migration.

## 11. Driver-agnostic recovery model

Recovery is implemented as a driver-agnostic Agenetes feature rather than route-owned or pi-specific replay orchestration.

`AgentCreateContext` carries an optional durable source record and folded `AgentTurn[]`, plus an instance-provided history-load authorization service. The default mount policy enables automatic recovery up to a 10,000 estimated-token limit and denies larger loads unless a host installs a different policy.

pi-driver serializes folded turns as JSON Lines inside one synthetic history message and seeds it through pi-agent-core's native `initialState.messages`. It does not require a Huabu projection port or a separate bootstrap model turn.

Opaque driver state remains deferred. Add a separate `driverState` channel only when a concrete driver requires more than the current session state and folded-turn model.

## 12. Capabilities and control

Deployment must not imply full control support. It means the handle has out-of-turn life and can accept control messages when it advertises them. Lifecycle (Job vs Deployment) and the advertised control set are related but not identical.

### 12.1. The capability descriptor: `supportedControlMessages` as the primary contract

Every host→agent **callable** capability is a control message from the closed, Agenetes-owned vocabulary. So the primary capability contract is a single uniform list — the subset of that vocabulary a handle honours. The current `AgentCapabilities.control` field is renamed to make this louder:

```ts
interface AgentCapabilities {
  // Primary contract: the subset of the closed control vocabulary this
  // handle honours. Adding a new callable capability = adding a member here;
  // no new bespoke field per capability.
  supportedControlMessages: ControlMsgType[];

  // Residual behavioural traits that are genuinely NOT callable control
  // messages, so they cannot fold into the list above:
  turnInput: 'blocking' | 'queue' | 'concurrent'; // data-plane run() behaviour
  loadSession?: boolean; // create-time resume capability
}
```

`turnInput` (can the host submit input mid-turn) is a data-plane run behaviour, and `loadSession` (can this handle resume from prior state at create) is a create-time lifecycle capability. Neither is a host→agent imperative, so both stay as their own fields. `slashCommands` is dropped: slash support is inferable from `available_commands_update` notifications (I8.2), so it needs no static flag.

This subsumes the earlier "boolean vs. control method" question into one rule: **a host→agent callable capability is always a control message and lives in `supportedControlMessages`; only a non-callable trait gets its own field.** `set_context` (below) is therefore just another member of the list, not a special case.

### 12.2. Capabilities are derived per handle (I8.6 dynamic phase)

`supportedControlMessages` is computed **per handle from the actual backend**, realizing the dynamic half of I8.6's two-phase negotiation (driver class advertises candidates at register; handle reports the negotiated set after create/initialize):

- The ACP handle derives it from the ACP `initialize` / `newSession` response: advertised modes → `set_mode`, advertised models → `set_model`, config options → `set_config_option`, a wired permission handler → `answer_permission`, always → `cancel`.
- The pi handle derives it from its lifecycle: a Job → `['cancel']`; a Deployment → `['cancel', 'set_context', …]`.

`handle.capabilities` (already on the handle in I8) is where this per-handle descriptor is reported; the driver-class `AgentDriverInfo.capabilities` remains the static candidate set for discovery/admission.

### 12.3. Driver self-description

`AgentDriverInfo` (in `@agenetes/runtime`) gains an optional human-readable field so a driver can describe itself, frontmatter-style, for discovery and UX:

```ts
interface AgentDriverInfo {
  /** Natural-language summary for discovery / UX. Never a gating input. */
  readonly description?: string;
  /** Structured capability descriptor; the source of truth for gating. */
  readonly capabilities: AgentCapabilities;
}
```

Rule (structured vs. natural language): a capability is **normalized into the structured descriptor only when a consumer branches on it at runtime** (admission, routing, UI enablement). Everything else — the long tail meant purely for humans — lives in `description`. `description` must never become an implicit gating channel (e.g. an LLM reading English to infer support); that would demote a gated capability into fragile prose. No `name` field is introduced, and the existing invariant that a driver carries no dispatch `kind` still holds.

### 12.4. Live context update: `set_context`

Refreshing the system prompt mid-conversation is a live host→agent imperative, so — per §12.1 — it is a control message, not a boolean. It is added to the closed vocabulary:

```ts
// CONTROL_MSGS gains:
SetContext: ('set_context',
  // payload (minimal first; extensible to tools later):
  (setContextControlDataSchema = z.object({
    systemPrompt: z.string().optional(),
  })));
```

A handle that supports live context refresh includes `set_context` in its `supportedControlMessages` (the pi Deployment handle does; Job handles and backends without the semantics omit it). When the current rendered prompt differs from the prompt last applied to a live handle, the host sends `{ type: 'set_context', data: { systemPrompt } }` before the next turn; the driver applies it by assigning `agent.state.systemPrompt`. This is the mechanism that replaces the legacy fresh-Agent prompt injection described in §9.2.

## 13. Huabu refactor plan

### ✅ M1. Extract pi handle code

The reusable pi handle logic has been extracted into [`external/agenetes/packages/pi-driver`](../../external/agenetes/packages/pi-driver). The former host-owned `builtin-handle.ts` execution path has now been deleted, leaving only the Huabu adapter and composition layers in the host.

- ✅ Reusable pi-agent-core execution logic moved into the standard subtree driver package.
- ✅ The last host-owned legacy built-in handle file has been removed.

### ✅ M2. Introduce pi driver ports

Huabu now registers pi-driver ports at mount time: model resolution delegates to [llm.ts](../../apps/server/src/modules/agent/llm.ts), tool resolution delegates to [tools/index.ts](../../apps/server/src/modules/agent/tools/index.ts), and request rendering continues to use the existing conversation renderer through the host composition layer.

- ✅ Model resolution is injected through host ports.
- ✅ Credential / API-key resolution is injected through host ports.
- ✅ Tool resolution is injected through host ports.
- ✅ Request rendering remains host-owned rather than driver-owned.

### ✅ M3. Compile Huabu profiles into pi workload specs

The built-in chat composition layer now compiles AGENT.md-derived settings into a serializable pi `recipe` plus opaque `hostContext`, instead of directly constructing a pi `Agent`.

- ✅ Built-in composition emits serializable `PiWorkloadSpec`.
- ✅ Profile/runtime choices now flow through recipe + hostContext rather than direct `Agent` construction.

### ✅ M4. Make interactive built-in threads Deployments

The chat path creates or reuses a Deployment handle per `threadId`, and both live continuation and restart recovery are owned below the route. System-prompt synchronization compares rendered content per live handle, avoiding redundant `set_context` controls while retaining memory/skill freshness.

- ✅ Main built-in chat path now uses `workloadType: "Deployment"`.
- ✅ Live turns reuse the Deployment handle instead of rebuilding history each turn.
- ✅ `set_context` is available and used on the Deployment path.
- ✅ Cold-start / restart uses Agenetes-managed recovery.
- ✅ `set_context` is sent only when rendered context changes, with one mandatory synchronization for recovered handles.

### ✅ M5. Remove legacy per-turn replay dependencies

Routine replay and the route-owned cold-start fallback have been removed. Agenetes now supplies durable input and policy, while pi-driver loads folded turns through native initial state.

- ✅ Normal live Deployment turns no longer rely on per-turn replay.
- ✅ Host-side cold-start recovery replay has been removed from the route.
- ✅ Agenetes-managed recovery is implemented.

### ✅ M6. Keep pipeline jobs explicit

The migration keeps pipeline and one-shot callers on `workloadType: "Job"` unless they need a long-lived conversation. The built-in main chat path is now the explicit Deployment consumer.

- ✅ Interactive built-in chat is the explicit Deployment consumer.
- ✅ Non-conversational callers can remain on `Job`.

### ✅ M7. Fold shipped design into architecture docs

The architecture docs describe both the Deployment cutover and the shipped recovery boundary.

- ✅ [`docs/architecture/agent-architecture.md`](../architecture/agent-architecture.md) already reflects the Deployment cutover.
- ✅ The recovery boundary and route ownership are settled.

## 14. Agenetes invariant updates

These updates should be made in host-application-neutral language. The Agenetes README should not mention Huabu-specific concepts or named application agents when describing general invariants.

| Invariant area                   | Current issue                                                                                                                                                                     | Proposed update                                                                                                                                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Standard vs host-builtin driver  | Current wording can imply in-process harness drivers are necessarily host-builtin custom drivers.                                                                                 | A standard driver can be in-process and still host-agnostic if behavior extension enters through mount-time ports and per-create serializable specs.                                                                                                                                       |
| Object-injection bridge          | Current text treats object injection as the bridge away from `create(spec)`, but does not clearly distinguish per-create object injection from mount-time port registration.      | State that `create(spec)` receives only serializable workload data; new behavior is registered at mount time as code ports.                                                                                                                                                                |
| Fresh SDK Job built-in           | Current description records the legacy fresh-agent-per-invocation path.                                                                                                           | Mark that pattern as transitional; interactive conversation drivers should use Deployment semantics when the harness supports long-lived state.                                                                                                                                            |
| Deployment realizability         | Current wording says Deployment requires ACP only.                                                                                                                                | Change to “Deployment requires a stateful runtime”; ACP and pi harness are examples.                                                                                                                                                                                                       |
| Render closure                   | Current `run(request, render, ctx)` shape captures the per-request render insight but creates tension with “messages, not closures” if the seam later crosses a process boundary. | Preserve per-request render semantics while allowing registered renderers or prepared serializable input at the seam.                                                                                                                                                                      |
| Capabilities vs lifecycle        | Current wording can imply Deployment means the full control set.                                                                                                                  | Decouple lifecycle from advertised control capabilities; a Deployment advertises the subset its runtime supports.                                                                                                                                                                          |
| Capability descriptor shape      | `AgentCapabilities.control` sits among heterogeneous fields; per-capability booleans invite ad-hoc growth.                                                                        | Rename `control` → `supportedControlMessages` and make it the primary contract: every host→agent callable capability is a member; only genuinely non-callable traits (`turnInput`, `loadSession`) keep their own field; drop `slashCommands` (inferable from `available_commands_update`). |
| Per-handle capability derivation | I8.6 already defines a dynamic per-handle phase, but capabilities are treated as mostly static per driver class.                                                                  | State that `supportedControlMessages` is derived per handle from the actual backend (ACP from its `initialize`/session capabilities; pi from its lifecycle), reported via `handle.capabilities`.                                                                                           |
| Control vocabulary extension     | The closed control vocabulary has no operation for live context refresh.                                                                                                          | Add `set_context` (payload `{ systemPrompt? }`, extensible) to the control union; support is declared by its presence in `supportedControlMessages`, not a redundant boolean.                                                                                                              |
| Driver self-description          | `AgentDriverInfo` carries only `capabilities`.                                                                                                                                    | Add an optional natural-language `description` for discovery/UX; normalize a capability into the structured descriptor only when a consumer branches on it, otherwise describe it. `description` is never a gating input; no dispatch `kind` or `name` is added.                           |
| Recovery state                   | Current examples are ACP-oriented around `sessionId`, but recovery is broader than the pi driver.                                                                                 | Track driver-agnostic recovery as future work; do not use pi-driver migration to introduce a driver-specific recovery replay model.                                                                                                                                                        |

## 15. Open questions

No unresolved protocol question remains for the first implementation pass.

Resolved during review (were open questions, now decided):

- `PiModelRef` for the first milestone is a host-managed symbolic selector (`{ type: 'host', id: string }`), with Huabu using `{ type: 'host', id: 'active' }`; see §8.
- pi-agent-core behavior guarantees for Deployment — verified against the installed version; see §9.1.
- Dynamic system-prompt / skill / memory refresh under a Deployment — modelled as a `set_context` control message carried in `supportedControlMessages`, driven by a per-handle rendered-content comparison; see §9.2 and §12.4.

The following are now decisions, not open questions for this proposal:

| Topic                       | Decision                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Factory ergonomics          | Defer; focus on pi driver. Standard factories may be preinstalled later, but host contract `kind` registration remains explicit.                              |
| Recovery replay             | Shipped as Agenetes durable input + policy with driver-owned loading; pi-driver uses native `initialState.messages`.                                          |
| Renderer fallback placement | Keep per-run render as primary. Optional fallback can be host-composed or driver-provided later, but it must not block the migration.                         |
| Spec drift                  | Follow existing reuse-ignores-spec semantics: no hidden reconcile. A changed profile requires explicit close/recreate or future explicit reconfigure control. |
| Remote pi runtime           | Non-goal for the first milestone; initial transport is in-process.                                                                                            |

## 16. Acceptance criteria

1. Interactive built-in conversations no longer rebuild a fresh pi `Agent` from history on every turn.
2. The standard pi driver package contains no Huabu canvas, profile, settings, route, or storage imports.
3. Huabu registers model, credential, tool, and request-render ports at Agenetes mount time.
4. The built-in chat path compiles host profiles into serializable pi workload specs.
5. Agenetes remains the only writer of durable conversation history.
6. Restart recovery is Agenetes-managed and driver-owned rather than route-owned or implemented through a pi-specific host replay path.
7. README invariant updates use host-application-neutral examples only.
