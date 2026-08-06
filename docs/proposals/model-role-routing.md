# Model Role Routing (per-task model selection)

Status: Partly shipped
Last updated: 2026-07-24

The tier configuration, role resolver, Utility settings, and automatic cheapest-eligible selection described here have shipped. Per-role overrides remain deferred. The current runtime contract is documented in [agent-architecture.md](../architecture/agent-architecture.md); this proposal preserves the design history.

> **Historical note.** The intent recogniser referenced below (`intent.service.ts`, the `intent` role) was removed from the product after this proposal was written. Those rows are design history only.

## Goal

Today Huabu drives every LLM call from a **single** active chat model (`getLLMModel()` → the one `activeConfig` in [`apps/server/src/modules/agent/llm.ts`](../../apps/server/src/modules/agent/llm.ts)). Chat, intent recognition, and every preprocessing enrichment share it.

But these tasks have very different capability needs. The main chat agent needs a frontier model (tool orchestration, long context, reasoning). Preprocessing — image/frame labeling, summary, keywords, title extraction — and intent suggestions are short, single-shot, no-tool tasks that a small/fast/cheap model handles fine. Running them on the frontier model wastes money, adds latency to high-frequency background work, and burns the frontier model's rate limit and context budget.

This proposal introduces a **data-driven model routing table**: every LLM call site is tagged with a named **role**, and a **role → model binding** config decides which model each role uses. Changing "which model runs where" becomes a config edit, not a code change. Image generation already proves the decoupling pattern (it uses a dedicated top-level `imageConfig`, independent of the chat provider); this generalizes that idea to all text/vision inference.

Design intent, in one line: **role catalog is data, binding is config, resolution is a single entry point.**

## Non-goals

- Not touching image generation (`generate_image` / `imageConfig`) — already decoupled.
- Not per-request model overrides from the agent itself (a role resolves to one model at a time).
- Not a full "route by prompt difficulty at runtime" router — routing is by static role, not dynamic classification.

## Background: current LLM call sites

A full sweep of the repo (every path that reaches `piComplete` / `piStream` / `getLLMModel`) yields exactly three inference entry points plus the already-split image path:

| Call site                                                                                                                                                                  | Function                       | Task shape                                                                                            | Role                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------- |
| [`preprocessing/provider-manager.ts`](../../apps/server/src/modules/preprocessing/provider-manager.ts) `generateImageLabel` / `generateFrameLabel` / `generateContentMeta` | `llmComplete`                  | label / summary / keywords / frame theme — short output, single turn, no tools                        | **utility**                         |
| `agent/intent.service.ts` `recognizeIntent` / `recognizeIntentStream` _(module since deleted)_                                                                             | `llmComplete` + `llmStream`    | intent candidates — structured JSON, single turn, no tools (sends a canvas screenshot → needs vision) | **utility**                         |
| [`agent/agenetes/drivers.ts`](../../apps/server/src/modules/agent/agenetes/drivers.ts) built-in agent (pi-agent-core)                                                      | `getLLMModel` + `ensureApiKey` | main conversation, tool orchestration, long context                                                   | **chat** (frontier)                 |
| [`agent/agent.route.ts`](../../apps/server/src/modules/agent/agent.route.ts) `getLLMModel().contextWindow`                                                                 | metadata read                  | token-budget the main agent                                                                           | must track **chat**                 |
| `generate_image` tool                                                                                                                                                      | `getAzureImageConfig`          | image generation                                                                                      | already independent (`imageConfig`) |

**Conclusion:** besides preprocessing, only **intent recognition** should move to the utility tier. The main agent must stay frontier, and the context-window read must track whatever the main agent uses.

### Vision caveat

Both `intent` (canvas screenshot) and `imageLabel` (the image itself) send an image part to the model. If a user points the utility tier at a text-only mini model, these would break. The resolver therefore applies a **vision guard**: when a role is marked `vision: true` and the resolved model does not support image input, resolution falls back up the chain (ultimately to the chat model, which today is always vision-capable in practice).

#### How image support is determined

No new capability probe is needed — the `Model` object already carries an `input: ('text' | 'image')[]` field, populated by `buildModel(cfg)` from three existing signal sources of decreasing reliability:

| Source                                      | Where                                                                                                                                                             | Reliability                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| pi-ai registry `m.input`                    | [`llm.ts` `getModelsForProvider`](../../apps/server/src/modules/agent/llm.ts) (`input: m.input`)                                                                  | **Accurate** — registry knows each built-in model's modalities                                                              |
| Copilot live `capabilities.supports.vision` | [`oauth.ts`](../../apps/server/src/modules/agent/oauth.ts) → [`llm.ts`](../../apps/server/src/modules/agent/llm.ts) (`live.vision ? ['text','image'] : ['text']`) | **Accurate** — queried from Copilot's `/models`                                                                             |
| manual-build fallback                       | [`llm.ts` `buildModel`](../../apps/server/src/modules/agent/llm.ts) (`input: ['text', 'image']`)                                                                  | **Optimistic** — Azure / custom / newer-than-registry models have no queryable metadata, so they are assumed vision-capable |

So the guard just **consumes the existing field** — `resolveModelForRole` reads `model.input.includes('image')`:

```ts
const model = buildModel(cfg);
const supportsImage = model.input.includes('image');
if (MODEL_ROLES[role].vision && opts.hasImage && !supportsImage) {
  // step up one level → ultimately the chat model
}
```

- For registry / Copilot models this correctly catches the common case (user picked a text-only mini for the utility tier).
- **Blind spot:** a manual Azure / custom deployment that is actually text-only reports `['text','image']` optimistically, so the guard won't fire and the request may be rejected at API time.

**Decision (option A):** accept the optimistic assumption for manual/custom endpoints — it matches the codebase's existing behavior everywhere on that path (the manual branch already assumes vision). Documented as a known limitation. A runtime "retry on chat model when the utility call fails with a vision error" fallback is possible but deferred; it adds error-classification complexity for a narrow case.

## Design

### 1. Role catalog — data (`packages/shared/src/llm/model-roles.ts`)

Each LLM call site is registered as a role with metadata: its default tier, whether it may receive images, and a display label for the settings UI.

```ts
export const MODEL_ROLES = {
  chat: { defaultTier: 'chat', vision: true, label: 'Chat agent' },
  memory: { defaultTier: 'utility', vision: false, label: 'Memory curation' },
  skill: { defaultTier: 'utility', vision: true, label: 'Skill authoring' },
  intent: { defaultTier: 'utility', vision: true, label: 'Intent suggestions' },
  imageLabel: { defaultTier: 'utility', vision: true, label: 'Image labeling' },
  frameLabel: {
    defaultTier: 'utility',
    vision: false,
    label: 'Frame labeling',
  },
  contentMeta: {
    defaultTier: 'utility',
    vision: false,
    label: 'Summary / keywords / label',
  },
} as const;

export type ModelRole = keyof typeof MODEL_ROLES;
export type ModelTier = 'chat' | 'utility';
```

Adding a future call site (e.g. `conversationTitle`, `compaction`, `router`) is a one-line addition here plus referencing the role at the call site. No scattered magic strings.

### 2. Config — two-layer binding

Storing a full provider/model config **per role** would explode the persisted store and the UI. Instead the config has two layers, resolved in priority order:

```
utilityConfig                     // one utility-tier model (chat-shaped); empty provider = auto (cheapest eligible in the chat provider)
roleOverrides?: Partial<Record<ModelRole, ModelBinding>>   // optional per-role override, power users only
```

- **Tier layer** (`utilityConfig`): the common case. Users configure at most two buckets — chat (the existing config) and utility.
- **Override layer** (`roleOverrides`): optional. Lets a power user pin one role to a specific model (e.g. give `imageLabel` a vision model while everything else uses a text-only mini) without affecting the others.

`utilityConfig` reuses the **chat config shape** — it is just another chat-capable model — so no new read interface is defined:

```ts
// packages/shared/src/types/api/llm.ts
export type LLMUtilityConfig = LLMConfig; // identical shape; alias only

// Update schema differs in ONE rule: provider may be empty (= follow chat),
// whereas chat's llmConfigUpdateSchema requires provider .min(1).
export const llmUtilityConfigUpdateSchema = llmConfigUpdateSchema.extend({
  provider: z.string(), // allow '' → follow chat
});
export type LLMUtilityConfigUpdate = z.infer<
  typeof llmUtilityConfigUpdateSchema
>;
```

`ModelBinding` (for the override layer) is `{ mode: 'inherit' } | LLMUtilityConfigUpdate` — reusing the same schema, not a new one. `roleOverrides` is optional and can ship empty; the override UI is deferred (§6), but the resolver honors it from day one so adding the UI later is a pure frontend change.

### 3. Resolution — single entry point (`llm.ts`)

All model selection funnels through one function so the priority order lives in exactly one place:

```
resolveModelForRole(role, opts?: { hasImage?: boolean }):
  1. roleOverrides[role]                    (explicit per-role override)
  2. tier config for MODEL_ROLES[role].defaultTier
       - 'chat'    → active chat config (getLLMModel today)
       - 'utility' → utilityConfig, or — when empty — the cheapest eligible
                     model in the chat provider (SHIPPED), then chat
  3. fallback: chat config
  + vision guard: if MODEL_ROLES[role].vision && opts.hasImage
    && resolved model.input excludes 'image' → step up one level (ultimately chat)
```

Implementation notes:

- Generalize the planned `getUtilityModel()` into `resolveModelForRole()`. It reuses the existing `buildModel(cfg)` and `resolveApiKey` machinery — utility/override models are built exactly like chat models.
- **Caching:** keep the existing `cachedModel` for chat. Add a small cache keyed by the effective binding (provider+model+baseUrl), invalidated whenever `setUtilityConfig` / `setRoleOverride` writes. When a role resolves to "follow chat", it returns `getLLMModel()` directly (no separate cache entry).
- The `hasImage` flag is derived by the caller (does this `Context` contain an image content part?) so the guard only kicks in when an image is actually being sent.

### 4. Call surface

`llmComplete` / `llmStream` gain a role selector instead of the earlier `tier` idea:

```ts
llmComplete(ctx, { role: 'contentMeta' });
llmStream(ctx, { role: 'intent' });
// role defaults to 'chat' → all existing callers are unchanged
```

`getLLMModel().contextWindow` in `agent.route.ts` stays as-is (it must reflect the chat model).

## Phasing

Each phase is independently shippable. The whole thing is **additive and backward-compatible**: with no utility config saved and no overrides, `resolveModelForRole` returns the chat model for every role — identical to today's behavior.

### Phase 1 — Shared contract

- New `packages/shared/src/llm/model-roles.ts` (role catalog + `ModelRole` / `ModelTier`).
- In `types/api/llm.ts`: `LLMUtilityConfig` alias, `llmUtilityConfigUpdateSchema` (`.extend`), `ModelBinding`, optional `roleOverrides` schema.

### Phase 2 — Server persistence + resolution ([`llm.ts`](../../apps/server/src/modules/agent/llm.ts))

- Add top-level `utilityConfig?` (and optional `roleOverrides?`) to `PersistedStore`, mirroring `imageConfig`.
- `getUtilityConfig()` / `setUtilityConfig()` (+ `setRoleOverride`) — mirror `getImageConfig` / `setImageConfig`; clear the utility cache on write.
- `resolveModelForRole(role, opts)` + `ensureApiKeyForRole(role)` with the vision guard.
- Add `{ role }` selector to `llmComplete` / `llmStream` (default `'chat'`).

### Phase 3 — Route ([`llm.route.ts`](../../apps/server/src/modules/agent/llm.route.ts))

- `GET` / `PUT /api/llm/utility-config` (loopback guard + `safeParse`, cloned from the image-config handlers).

### Phase 4 — Switch call sites to roles

**Shipped call sites:** preprocessing, Memory curation, and explicit Skill authoring commands.

- `provider-manager.ts`: the three `llmComplete` calls → `{ role: 'imageLabel' | 'frameLabel' | 'contentMeta' }`, passing `hasImage` for the image path.
- The Memory curator uses the `memory` role through the built-in pi-driver host adapter.
- `/create-skill` and `/update-skill` use the `skill` role through a fresh Job, with image-aware fallback to Chat when needed. Ordinary task Skills continue on the Chat Model.
- **Removed:** the intent recogniser (and with it the `intent` role) was deleted from the product; the historical rows below are kept only as design history.

### Phase 5 — Web UI ([`LLMSettings.tsx`](../../apps/web/src/components/Settings/sections/LLMSettings.tsx) + `api/llm.ts` + `store/llmStore.ts`)

- Store/api: `utilityConfig` + `getUtilityConfig` / `updateUtilityConfig` (clone the image path).
- New `SettingSection` "Utility Model": a **"Follow chat model"** toggle (default on) that hides provider/model; when off, reuse the existing chat provider/model `<Select>` cluster (extract a shared sub-component). Subtitle explains "used for labeling, summaries, intent — pick a faster/cheaper model."
- i18n keys (`settings.utilityModel`, `settings.utilityModelDesc`, `settings.followChatModel`), passing `check-i18n-parity`.
- **Deferred:** per-role override UI ("Advanced → per task"). Data + resolver already support it; only the UI is postponed.

### Phase 6 — Docs

- Update [`node-preprocessing.md`](../architecture/node-preprocessing.md) to note preprocessing runs on the utility tier.
- On ship, fold the role-routing model (catalog + two-layer resolution) into `docs/architecture/` and mark this proposal `Shipped`.

## Design rationale

- **Role catalog is data.** New call sites and re-pointing are config/data edits, not surgery across the codebase.
- **Two layers, not per-role configs.** 99% of users configure two buckets (chat + utility); power users can still pin individual roles. Avoids UI/persistence blow-up while keeping full flexibility.
- **Reuse the chat config shape.** `utilityConfig` is chat-shaped, so no new read interface — only the one update schema whose validation genuinely differs (provider may be empty = follow chat). `.extend` reuses the rest.
- **Single resolution entry point.** The priority order and vision guard live in exactly one function, so behavior can't drift between callers.
- **Backward-compatible by construction.** Empty config → everything resolves to chat → zero behavior change, zero migration.

## Resolved decisions

1. **Role granularity — keep as-is.** The five-role catalog (chat / intent / imageLabel / frameLabel / contentMeta) is sufficient; `contentMeta` stays a single role (no label/summary/keywords split). Finer roles can be added later as pure data.
2. **Utility auth — reuse the per-provider credential store, with an inline key input for un-authenticated providers (v1.5).** Credentials live in the shared `providers` map keyed by provider id. The utility tier picks a `provider` + `model` and reuses whatever key/OAuth that provider already has stored. The utility provider dropdown lists **all** providers; selecting one that has no stored key reveals an **inline API-key input** that writes straight back into the same `providers` map (no separate/independent auth system). So the user can point utility at either an already-configured provider or a brand-new one without leaving the utility panel. A fully independent auth stack (chat and utility using unrelated credential silos) remains out of scope.
3. **Scope — preprocessing, Memory, and Skill authoring.** Ordinary task Skills stay on Chat. (Intent recognition was later removed from the product entirely.)
