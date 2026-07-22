# Chat session-level capability controls (built-in agent)

Status: Proposed
Last updated: 2026-07-22

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

| Control             | Wireable now | Mechanism                                                                                                     |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| Model               | ✅           | pi-agent-core `AgentState.model` (settable per thread)                                                        |
| Reasoning effort    | ✅           | `AgentState.thinkingLevel` / `reasoningEffort` stream option; gated by each model's `supportsReasoningEffort` |
| Fast / service tier | ✅           | `serviceTier` stream option                                                                                   |
| Standard / Pro      | ❌           | not exposed by pi-ai                                                                                          |
| Response verbosity  | ❌           | not exposed by pi-ai                                                                                          |

### Decision: plan (a) vs (b)

- **Plan (a) — recommended.** Ship the three wireable controls (Model, Reasoning effort, Service tier) now; defer Standard/Pro and Verbosity until pi-ai exposes them. All changes stay in Huabu code; low risk.
- **Plan (b).** Additionally upgrade or patch the vendored pi-ai to add the Standard/Pro and Verbosity parameters, delivering all five at once. Larger blast radius; touches the vendored SDK; higher regression risk.

This proposal is written for **plan (a)**. Standard/Pro and Verbosity are carried in the design as forward-compatible fields but are not rendered until their backing parameter exists.

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

Every field is optional; an absent field means "use the Settings default". The overlay is keyed by `threadId` and lives with the other per-thread durable state (host-side store keyed by `threadId`, or `AgentPersistentState.metadata` on the agenetes `ThreadRecord`; chosen in Stage 2).

## Capability source (normalized)

A normalized capability descriptor per model, so the UI renders identical controls regardless of agent kind:

```ts
interface ModelCapability {
  reasoningEfforts?: string[]; // e.g. ['low','medium','high']; omitted → no reasoning control
  serviceTiers?: string[]; // e.g. ['auto','flex','priority']
  // reasoningModes?, verbosity? — plan (b)
}
```

- **Built-in providers:** derived server-side from pi-ai's per-model flags (`reasoning`, `supportsReasoningEffort`) plus a small static matrix for the effort/tier _value lists_ pi-ai does not enumerate. Exposed on `LLMModelInfo` (extending the type shipped in the earlier cost/context change) so the existing `GET /api/llm/models` already carries it.
- **External ACP:** the agent's `configOptions` are already the capability surface (`category: 'model' | 'mode' | 'thought_level' | …`); no server matrix needed.

## Resolution & wiring (server)

The effective per-turn config is `{ ...settingsDefault, ...threadOverlay }`:

- `model` → the built-in handle's `AgentState.model` for that thread (already settable in pi-agent-core).
- `reasoningEffort` → `thinkingLevel` / the `reasoningEffort` stream option; only sent when the resolved model's `supportsReasoningEffort` is true.
- `serviceTier` → the `serviceTier` stream option.

`llmStream` / `llmComplete` already thread `ProviderStreamOptions` through to pi-ai; the built-in agent path ([`agent.service.ts`](../../apps/server/src/modules/agent/agent.service.ts) → pi-driver) must forward the thread overlay into the per-turn options. Exact plumbing (per-turn option vs `AgentState` mutation) is a Stage 3 detail.

## Auto-correction on model switch

When the thread's model changes, re-validate the overlay against the new model's `ModelCapability`: drop `reasoningEffort` if the new model has none, clamp it to the nearest supported level otherwise; drop `serviceTier` if unsupported. This runs both client-side (immediate UI) and server-side (authoritative) so a stale overlay never reaches pi-ai.

## UI

Generalize the existing ACP pill row into one shared control that both agent kinds render:

- External ACP: unchanged — driven by `configOptions` (already shipped, incl. the microsoft/Huabu#31 modern-preference fix).
- Built-in: a sibling adapter that maps `ModelCapability` + the current thread overlay to the same pill components, writing changes to a new per-thread settings endpoint.

Only controls whose capability list is non-empty render, matching the "hidden when empty" behavior of `AcpSessionSelectors`.

## Staging

- **Stage 1** — `ModelCapability` normalization: extend `LLMModelInfo` with `reasoningEfforts` / `serviceTiers`, populate from pi-ai flags + the static value matrix, tests. (Server + shared only; no behavior change.)
- **Stage 2** — per-thread `ChatSessionSettings` store + `GET`/`PUT` endpoint; new threads seeded from Settings defaults.
- **Stage 3** — wire the overlay into the built-in per-turn options (model / reasoningEffort / serviceTier); server-side auto-correction.
- **Stage 4** — shared chat-input UI for the built-in agent; client-side auto-correction + optimistic updates.
- **Later (plan b)** — vendored pi-ai support for Standard/Pro + Verbosity, then render those controls.

## Open questions

- Storage home for the overlay: a dedicated host store vs `AgentPersistentState.metadata`.
- Whether `serviceTier` should be user-exposed at all (billing implications) or gated behind a setting.
- Reasoning-effort value lists for non-OpenAI built-in providers (Anthropic thinking levels) — normalize or hide.

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
