# Chat session-level capability controls (built-in agent)

Status: Proposed
Last updated: 2026-07-23

## Goal

The chat input should expose the current model's tunable knobs — model, reasoning effort, reasoning mode (Standard/Pro), response verbosity, and service tier (Fast) — as dynamic, per-conversation controls, the same way external ACP agents already surface their `configOptions` via [`AcpSessionSelectors`](../../apps/web/src/components/Panels/ChatPanel/AcpSessionSelectors.tsx).

Today the built-in Huabu agent (pi-ai providers, including GitHub Copilot) has no in-chat controls at all: its model is a single global setting changed only in Settings ([`llm.ts`](../../apps/server/src/modules/agent/llm.ts) `activeConfig`), and reasoning/verbosity/tier are never exposed. This proposal adds a shared control surface for both agent kinds, driven by different data sources.

## Product requirements

- Controls appear **dynamically** based on the active model's capability.
- They are switchable **mid-conversation**.
- They are saved **per thread**, never overwriting the global Settings defaults.
- Switching model **auto-corrects** any now-incompatible settings (drop or clamp).
- A **new conversation** starts from the Settings defaults.
- Built-in and ACP agents share the **same UI**, with different data sources: built-in = Huabu's normalized capability; external ACP = the agent's returned `configOptions`.

## Hard constraint — pi-ai capability surface

The installed `@earendil-works/pi-ai` [`OpenAIResponsesOptions`](../../apps/server/node_modules/@earendil-works/pi-ai/dist/providers/openai-responses.d.ts) exposes only `reasoningEffort` (`minimal | low | medium | high | xhigh`), `reasoningSummary`, and `serviceTier`. It has **no** `text.verbosity` and **no** Standard/Pro reasoning-mode parameter.

| Control             | Wireable now | Mechanism                                                                                                                                                                                                                                                       |
| ------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model               | ✅           | Host `resolveModel` port re-resolves the thread's symbolic `PiModelRef` every turn ([handle.ts](../../external/agenetes/packages/pi-driver/src/handle.ts)); today `id:'active'`→global. Per-thread = resolve a concrete id from the thread's durable selection. |
| Reasoning effort    | ✅           | `reasoningEffort` stream option, gated by `model.supportsReasoningEffort`; value list from pi-ai `getSupportedThinkingLevels(model)`                                                                                                                            |
| Fast / service tier | ✅           | `serviceTier` stream option (OpenAI-responses / codex-responses / azure-responses `api` only)                                                                                                                                                                   |
| Standard / Pro      | ❌           | not exposed by pi-ai                                                                                                                                                                                                                                            |
| Response verbosity  | ❌           | not exposed by pi-ai                                                                                                                                                                                                                                            |

### Decision: plan (a) vs (b)

- **Plan (a) — recommended.** Ship the three wireable controls (Model, Reasoning effort, Service tier) now; defer Standard/Pro and Verbosity until pi-ai exposes them. All changes stay in Huabu code; low risk.
- **Plan (b).** Additionally upgrade or patch the vendored pi-ai to add the Standard/Pro and Verbosity parameters, delivering all five at once. Larger blast radius; touches the vendored SDK; higher regression risk.

This proposal is written for **plan (a)**. Standard/Pro and Verbosity are carried in the design as forward-compatible fields but are not rendered until their backing parameter exists.

## Architecture findings (verified 2026-07-23)

Code reading that shaped the resolved design below:

- **Built-in model is a symbolic host ref, re-resolved every turn.** [`PiModelRef`](../../external/agenetes/packages/pi-driver/src/types.ts) is `{ type:'host', id, options? }`; the driver never interprets it. [handle.ts](../../external/agenetes/packages/pi-driver/src/handle.ts) re-runs the host `resolveModel(ref, ctx)` port at **every turn boundary**, and `ctx` (`PiModelContext`) carries `threadId` + `namespace` + `hostContext`. So per-thread selection needs only a value the host `resolveModel` can read per `threadId` — no per-turn spec rewrite.
- **Conversation state already lives in Agenetes (Chat-V2).** History is the two-tier `chat_v2/` log and durable workload records are `threads.json` (`agenetes-v2`), both under the canvas `.history/` namespace root; see [agent-architecture.md](../architecture/agent-architecture.md) §5. `CanvasStore` no longer owns chat.
- **`AgentStateSnapshot = { driverState, metadata? }` splits cleanly.** `driverState` is driver-private (ACP's `AcpDurableState` is just `sessionId` + `initialPreambleDelivered`; pi's `piDurableStateSchema` is empty today). `metadata` ([`agentMetadataSchema`](../../external/agenetes/packages/protocol/src/agent-metadata.ts)) is the **driver-agnostic display snapshot** ACP folds its selection into (`currentModelId`, `configOptions`, …) and the UI reads uniformly.
- **`configOptions` is the extensible knob slot — not a hack.** `SessionConfigOption.category` reserves `thought_level` for reasoning level and allows custom `_`-prefixed categories, so `reasoningEffort` maps to a first-class `thought_level` option and `serviceTier` to a custom `_service_tier` option. Extending the protocol schema for these would reinvent an existing slot.
- **pi-ai 0.81.1 exposes the capability directly.** `getSupportedThinkingLevels(model)` returns a model's effort list and `clampThinkingLevel(model, level)` clamps to the nearest supported — so Stage 1's value list and Stage 3's auto-correction are direct pi-ai reads, retiring the earlier "static matrix" plan for reasoning effort. (`serviceTier` still has no per-model enumeration; derive its list from the model's `api`.)

### Resolved storage decision

Split by concern; **the protocol schema is NOT extended**:

| Aspect                                                                    | Home                                                                                                     | Shared with ACP?                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Display snapshot** (what the shared UI reads)                           | `AgentStateSnapshot.metadata`: `currentModelId` + two `configOptions` (`thought_level`, `_service_tier`) | ✅ same shape/format                          |
| **Authoritative selection** (what `resolveModel` / per-turn options read) | pi driver's own `driverState` `{ modelId?, reasoningEffort?, serviceTier? }`                             | ❌ pi-private (do not copy `AcpDurableState`) |

- **Recommended — Path B (durable state in the pi-driver snapshot).** The selection rides the `ThreadRecord` snapshot, so fork/rehydration carry it for free, symmetric with ACP. Cost: touches the `external/agenetes/pi-driver` (and possibly `protocol`) subtree — **separate commit(s)** per repo rules.
- **Alternative — Path 2 (host overlay).** Keep `recipe.model` symbolic; store the overlay in a host store keyed by `ctx.threadId` and read it inside the host `resolveModel`. Zero subtree change, but fork (currently `501`, #321) must be taught to copy it. Suitable as a lighter MVP; migratable into Path B later.

## Data model

A per-thread, optional overlay on top of the global chat config:

```ts
// packages/shared/src/types/api/llm.ts (new)
interface ChatSessionSettings {
  model?: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority';
  // forward-compat, plan (b): reasoningMode?: 'standard' | 'pro'; verbosity?: 'low' | 'medium' | 'high';
}
```

Every field is optional; an absent field means "use the Settings default". This is the **wire/overlay** shape (endpoint payloads + the effective-config merge). Its persistence is split per the resolved storage decision above: the **authoritative** values live in the pi driver's `driverState` (Path B) or a host overlay keyed by `threadId` (Path 2), while the **display** projection is folded into `AgentStateSnapshot.metadata` (`currentModelId` + `thought_level` / `_service_tier` `configOptions`) that the shared UI reads.

## Capability source (normalized)

A normalized capability descriptor per model, so the UI renders identical controls regardless of agent kind:

```ts
interface ModelCapability {
  reasoningEfforts?: string[]; // e.g. ['low','medium','high']; omitted → no reasoning control
  serviceTiers?: string[]; // e.g. ['auto','flex','priority']
  // reasoningModes?, verbosity? — plan (b)
}
```

- **Built-in providers:** `reasoningEfforts` is a direct pi-ai read — `getSupportedThinkingLevels(model)` (minus `off`), gated by `model.supportsReasoningEffort`. `serviceTiers` has no per-model enumeration, so derive it from the model's `api` (a static list for OpenAI-responses / codex-responses / azure-responses; empty otherwise). Both are exposed on `LLMModelInfo` (extending the type shipped in the earlier cost/context change) so the existing `GET /api/llm/models` already carries it.
- **External ACP:** the agent's `configOptions` are already the capability surface (`category: 'model' | 'mode' | 'thought_level' | …`); no server matrix needed.

## Resolution & wiring (server)

The effective per-turn config is `{ ...settingsDefault, ...threadSelection }`, resolved through the pi driver's host ports (which already receive `ctx.threadId`):

- `model` → the host `resolveModel(ref, ctx)` resolves the thread selection's concrete `modelId` (falling back to the global `'active'` when unset); `getApiKey` follows.
- `reasoningEffort` → the `reasoningEffort` stream option, only sent when the resolved model's `supportsReasoningEffort` is true.
- `serviceTier` → the `serviceTier` stream option, only for `api`s that support it.

The selection reaches the ports via the pi `driverState` (Path B) or a host overlay keyed by `ctx.threadId` (Path 2). The reasoning/tier stream options are injected at the per-turn call site in [handle.ts](../../external/agenetes/packages/pi-driver/src/handle.ts) (Path B) or by the host per-turn options plumbing (Path 2).

## Auto-correction on model switch

When the thread's model changes, re-validate the selection against the new model's `ModelCapability`: drop `reasoningEffort` if the new model has none, else clamp it via pi-ai `clampThinkingLevel(model, level)` to the nearest supported level; drop `serviceTier` if the new model's `api` does not support it. This runs both client-side (immediate UI) and server-side (authoritative) so a stale selection never reaches pi-ai.

## UI

Generalize the existing ACP pill row into one shared control that both agent kinds render:

- External ACP: unchanged — driven by `configOptions` (already shipped, incl. the microsoft/Huabu#31 modern-preference fix).
- Built-in: a sibling adapter that maps `ModelCapability` + the current thread overlay to the same pill components, writing changes to a new per-thread settings endpoint.

Only controls whose capability list is non-empty render, matching the "hidden when empty" behavior of `AcpSessionSelectors`.

## Staging

Written for **Path B** (durable state in the pi-driver snapshot). For Path 2, swap the Stage 2 subtree work for a host store keyed by `threadId`. 🟠 = `external/agenetes` subtree → **separate commit**.

- **Stage 1** — `ModelCapability` normalization (server + shared only; no behavior change):
  - [packages/shared/src/types/api/llm.ts](../../packages/shared/src/types/api/llm.ts): add `reasoningEfforts?: string[]` / `serviceTiers?: string[]` to `LLMModelInfo`.
  - [apps/server/src/modules/agent/llm.ts](../../apps/server/src/modules/agent/llm.ts) `toModelInfo`: populate from `getSupportedThinkingLevels(model)` + `model.supportsReasoningEffort`, and an `api`-derived `serviceTiers` list.
  - `GET /api/llm/models` ([llm.route.ts](../../apps/server/src/modules/agent/llm.route.ts)) carries it automatically; add tests.
- **Stage 2** 🟠 — per-thread durable selection in the pi driver:
  - [pi-driver/src/types.ts](../../external/agenetes/packages/pi-driver/src/types.ts): extend `piDurableStateSchema` → `{ modelId?, reasoningEffort?, serviceTier? }`.
  - [pi-driver/src/handle.ts](../../external/agenetes/packages/pi-driver/src/handle.ts): read it in `run()`; up-report `metadata` (`currentModelId` + `thought_level` / `_service_tier` `configOptions`) via `onState`.
- **Stage 3** — host resolution wiring + auto-correction:
  - [apps/server/src/modules/agent/agenetes/pi-driver.ts](../../apps/server/src/modules/agent/agenetes/pi-driver.ts) `resolveModel` / `getApiKey`: resolve the concrete per-thread `modelId`; inject `reasoningEffort` / `serviceTier` per-turn options.
  - [apps/server/src/modules/agent/llm.ts](../../apps/server/src/modules/agent/llm.ts): "resolve concrete `Model` by id" helper.
  - Seed new threads from Settings defaults; server-side auto-correct on model switch (`clampThinkingLevel`).
- **Stage 4** — set endpoints + shared UI:
  - Built-in set endpoints mirroring the ACP set-RPCs ([acp/threads.route.ts](../../apps/server/src/modules/agent/acp/threads.route.ts)); each mutates the selection and up-reports `metadata`.
  - Generalize [`AcpSessionSelectors`](../../apps/web/src/components/Panels/ChatPanel/AcpSessionSelectors.tsx) + [`useAcpSessionMeta`](../../apps/web/src/hooks/useAcpSessionMeta.ts) to render the built-in thread's `metadata` (same shape); client-side auto-correction + optimistic updates; [apps/web/src/api/llm.ts](../../apps/web/src/api/llm.ts) calls (zod-free, `import type` only).
- **Later (plan b)** — vendored pi-ai support for Standard/Pro + Verbosity, then render those controls.

### Explicitly not doing

- **Not** extending `@agenetes/protocol`'s `agentMetadataSchema` — `configOptions` already provides the `thought_level` / custom-category slot.
- **Not** copying ACP's `AcpDurableState` fields — the pi driver keeps its own minimal durable state.

## Open questions

- **Path B vs Path 2** — accept the `external/agenetes` subtree change now for fork/rehydration parity with ACP (Path B), or ship the host-overlay MVP first (Path 2) and migrate later? (Fork is currently `501`/#321, so the parity benefit is forward-looking.)
- Whether `serviceTier` should be user-exposed at all (billing implications) or gated behind a setting.
- Reasoning-effort value lists for non-OpenAI built-in providers (Anthropic thinking levels) — `getSupportedThinkingLevels` covers enumeration, but confirm the UI labels/order read sensibly across providers.

## Spike: pi-ai 0.80.7 upgrade feasibility (2026-07-22)

Investigated whether upgrading `@earendil-works/pi-ai` (+ `pi-agent-core`) from the pinned 0.75.5 to the current npm release supersedes our patch-style workarounds (the `openai-codex` GPT-5.6 additions, the Copilot `openai-completions` hard-code, the custom OAuth in `oauth.ts`, and the custom OpenAI `/v1/models` fetch). Research-only; no functional code changed.

### Findings

- **Versions / lockstep.** npm `latest` is **0.80.7** for **both** `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`, published in lockstep; `pi-agent-core@0.80.7` depends on `pi-ai ^0.80.7`. The upstream README (0.81.1, main branch) is ahead of npm — the GPT-5.6 catalog entries and `getSupportedThinkingLevels()` shown there may not be in npm 0.80.7 yet, so that must be re-checked at bump time.
- **pi-agent-core contract is backward-compatible.** `Agent`'s `AgentOptions` in 0.80.7 still takes `initialState.model` (a plain serializable `Model`), `getApiKey(provider)`, `convertToLlm`, and `toolExecution`, plus new _optional_ fields (`transport`, `thinkingBudgets`, `streamFn`). It imports its wire types from `@earendil-works/pi-ai/compat`. So pi-driver's `new Agent({ initialState: { model }, getApiKey })` call ([handle.ts](../../external/agenetes/packages/pi-driver/src/handle.ts)) keeps working — **the new `createModels`/`Models` collection API is NOT forced by the upgrade.**
- **Root entrypoint moved.** In 0.80.7 the root exports the new collection/auth API (`models.ts`, `auth/credential-store`, OAuth types); the old globals we use in [llm.ts](../../apps/server/src/modules/agent/llm.ts) (`getModel` / `getModels` / `stream` / `complete` / `getProviders` / `getEnvApiKey`) are **gone from root** and live on `@earendil-works/pi-ai/compat`. The minimal upgrade is therefore a mechanical import-path change (`@earendil-works/pi-ai` → `.../compat`), described upstream as "verbatim behavior, one import-path change".
- **CredentialStore adapter is feasible but deferrable.** pi-ai's `CredentialStore` (`read`/`list`/`modify`/`delete`, type-tagged `api_key`|`oauth` credentials) maps cleanly onto our [`SecretStore`](../../apps/server/src/security/secret-store-types.ts) (`get`/`set`/`setMany` by id) via a `providerId → namespaced secret id` + JSON-encoded credential adapter. Only needed if we adopt native auth; not a blocker for the version bump.
- **Copilot 400 / GPT-5.6.** The new provider architecture dispatches per model `api` (so a GPT-5.6 model would route to `openai-responses`, fixing the `/chat/completions` 400 at the root) — but only if the installed catalog actually carries GPT-5.6 with the right `api`. Since GPT-5.6 appears to be 0.81-only, on 0.80.7 we likely still keep `OPENAI_CODEX_MODEL_ADDITIONS` and/or use dynamic `refresh()`. Verify at bump.

### Go / no-go: GO, staged (lower risk than first assumed)

- **Phase A (minimal, low-risk).** Bump `pi-ai` + `pi-agent-core` to `^0.80.7` in `apps/server` and `external/agenetes/pi-driver` (separate subtree commit for pi-driver); switch the `llm.ts` old-global imports to `@earendil-works/pi-ai/compat`; keep `oauth.ts`, the `/v1/models` fetch, and the GPT-5.6 additions as-is. Verify workspace typecheck + server tests + the Electron single-file bundle (may need the documented Node `require` shim).
- **Phase B (targeted Copilot 400 fix).** Independent of the bump: route Copilot Responses-only models to `openai-responses` in `buildModel`, or drop the hard-code if the newer catalog fixes it natively.
- **Phase C (optional, later — "de-patch").** Adopt the new `createModels`/`createProvider` collection API, native OAuth (`models.login` + the CredentialStore adapter), and dynamic `refresh`/`fetchModels` — retiring `oauth.ts`, the custom `/v1/models` fetch, and the GPT-5.6 additions. Also exposes `getSupportedThinkingLevels()` / `compat.supportsReasoningEffort`, which turns this proposal's Stage 1 capability matrix into a direct pi-ai read.

Net: our patches were correct workarounds for 0.75.5, not mistakes. The upgrade is worthwhile and **much cheaper than initially feared** (compat keeps the old API; pi-agent-core still takes `{ model, getApiKey }`), so the big collection-API/OAuth refactor can be deferred to Phase C rather than blocking the bump.
