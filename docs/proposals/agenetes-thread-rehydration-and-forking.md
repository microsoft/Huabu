# Agenetes Thread Rehydration and Forking

> Unify recovery-only replay and thread forking under one Agenetes-managed model for realizing live agent state from durable thread state.
>
> Status: **Draft** · Last updated 2026-07-11

---

## 1. Context

The main Huabu built-in chat path now runs as a live pi-driver `Deployment`, not as a per-turn fresh-Job replay loop. That cutover exposed one remaining boundary problem: on cold start or restart, the host route still loads `priorTurns` and rebuilds pi context itself instead of letting Agenetes own recovery.

At the same time, issue [#285](https://github.com/hai-team/Sediment/issues/285) asks for thread forking to become standard behavior across all agents rather than a built-in-only feature, and issue [#295](https://github.com/hai-team/Sediment/issues/295) tracks moving recovery-only replay into Agenetes-managed recovery.

These are not identical product features, but they are the same systems problem family: given durable thread state, how does Agenetes realize a live runtime again, either for the same `threadId` or for a new one?

## 2. Goals

1. Define a driver-agnostic Agenetes model for rehydrating a live agent runtime from durable thread state.
2. Design thread forking as a sibling operation to recovery, not as a host-only built-in special case.
3. Remove host-route ownership of history replay for built-in recovery.
4. Preserve the host/L2 boundary: hosts may provide projection/render ports, but Agenetes owns the recovery and fork lifecycle.
5. Treat recovery primarily as an automatic lifecycle behavior, while keeping fork as an explicit operation.

## 3. Non-goals

This proposal does not reintroduce per-turn replay for normal live conversations.

This proposal does not require every driver to recover in the same way. ACP may prefer session resume; pi may rebuild runtime state from durable turns; other drivers may use different native snapshots.

This proposal does not make Agenetes understand host-specific request payloads such as Huabu's `ChatEnvelope` directly. Host-specific projection remains a registered extension point.

## 4. Unifying model

Recovery and forking are two variants of the same operation:

| Operation | Source durable state | Target live state |
| --- | --- | --- |
| Recovery | Thread `T` | Recreate or resume live runtime for the same thread `T` |
| Forking | Thread `T` | Create a new live runtime for a new thread `T'` derived from `T` |

In both cases the runtime may need some mixture of:

- durable thread record (`spec`, `priorState`)
- folded turn history (`AgentTurn[]`)
- backend-native recovery data if the driver had previously persisted it
- host-provided projection from durable turns into backend-native input/state

The important boundary is that Agenetes decides **when** rehydration is needed and **which durable facts** are supplied to the driver, while each driver decides **how** to rebuild its backend-native runtime.

## 5. Current design direction

The current design direction is to treat **recovery** and **forking** differently at the surface:

- **Recovery** should usually be an **automatic lifecycle behavior**, not a product-facing explicit API.
- **Forking** should remain an **explicit operation**, because it creates a new thread identity and is a clear user/host intent.
- The first recovery policy placement should be **instance-level configuration at Agenetes mount time**, not route-local or per-request policy plumbing.

In other words, the primary caller intent for recovery is not "call recover now", but "realize this existing thread as a live Deployment". If the thread already has a durable record but no usable live handle, Agenetes should decide whether to attempt recovery according to policy and driver capabilities.

That means the important design surface may be less "a recover API" and more "how Agenetes realizes a Deployment when live state is missing but durable state exists".

The current recovery direction also prefers a **fallback ladder** over a one-shot replay decision:

1. reuse the live handle when one already exists
2. when no live handle exists but a durable record does, enter recovery candidacy
3. try lower-risk/native recovery first (session resume, snapshot restore, other driver-native mechanisms)
4. only consider history-based recovery when earlier layers cannot realize the thread
5. deny or require explicit confirmation when the remaining recovery path is too uncertain

In this model, "durable record exists but no live handle exists" is the **entry condition for a recovery ladder**, not the same thing as "start replay now".

## 6. Candidate layering

The likely ownership split is:

| Layer | Responsibility |
| --- | --- |
| Host (`apps/server`) | Supplies host-specific ports that can project durable turns into backend-native input/state when the driver cannot recover from native snapshot alone. |
| Agenetes instance/runtime | Owns recovery/fork orchestration, reads durable thread state, and passes recovery inputs to drivers. |
| Driver (`pi-driver`, `acp-driver`, future drivers) | Chooses native resume vs history projection vs mixed strategy for one backend. |

This means the current Huabu route-level sequence:

```text
history() -> priorTurns -> resumeThreadContext() -> runAgent()
```

should eventually become something closer to:

```text
create-or-recover(spec) -> driver-owned rehydration -> run()
```

with any host-specific history projection hidden behind registered ports rather than route code.

## 7. Recovery policy and uncertainty budget

Automatic recovery should not mean unconditional replay. Recovery is only safe when the system has enough confidence that durable state can be rehydrated without silently drifting semantics too far.

The likely policy shape needs to answer at least these questions:

- When a durable thread record exists but no live handle exists, should Agenetes attempt recovery automatically?
- Should the driver first try native resume (`session/load`, snapshot restore, etc.) before any history-based recovery?
- When history-based recovery is required, when is the projected replay small/stable enough to allow?
- When it is too large or too uncertain, should the system deny recovery, require a user-visible confirmation, or fall back to a more lossy mode?

The key risk is not just turn count, but **recovery uncertainty**. A long replay may trigger harness compaction, truncation, or other backend-native behaviors whose effect is not fully predictable. So the gating threshold should likely be framed as a **recoverability budget**, not a single boolean.

For now, the design direction is to use a **cheap estimation** only. This is a heuristic recoverability gate, not billing-grade token accounting and not a precise tokenizer-backed budget system.

Possible budget dimensions include:

- folded turn count
- approximate token/size estimate derived cheaply from durable turns
- approximate tool-result payload size
- presence of content that is expensive or unstable to replay

The threshold values themselves should be configurable (for example, a conservative `safeAutoRecoverTokens`-style setting). The current direction is to place that configuration at the **Agenetes instance level** during mount. This proposal does not fix the exact policy object yet; it treats the threshold/budget problem as a first-class design constraint rather than an implementation detail.

When recovery exceeds the safe automatic budget, the preferred behavior is:

- **confirm** when a user-visible confirmation flow is simple enough to implement cleanly
- otherwise **deny/fail fast**

The first implementation therefore does not need to force a confirmation UX if that path would complicate the system too much; a deny-first implementation is acceptable.

## 8. Candidate seam

The current runtime seam already down-feeds `priorState` into `driver.create(spec, priorState)`. That is enough for native session resume flows such as ACP `session/load`, but it is not enough for history-based recovery or fork-from-history.

The minimal extension should likely add a recovery/fork input alongside `priorState`, rather than teaching route handlers to read `history()` and replay manually.

One plausible shape is:

```ts
interface AgentRecoveryInput<TSpec = unknown> {
  readonly sourceThreadId?: string;
  readonly sourceSpec?: TSpec;
  readonly priorState?: AgentStateSnapshot;
  readonly turns?: readonly AgentTurn[];
}
```

This proposal does not lock that exact API yet. The important design rule is that `AgentTurn[]` and any derived recovery inputs should flow **through Agenetes into the driver**, not around Agenetes through host route code.

One consequence of the current direction is that a future recovery design may not need to expose a public `recover(...)` call at all. Instead, Agenetes may only need:

- an internal realization/recovery seam
- a configurable auto-recover policy
- a separate explicit fork operation

## 9. Driver implications

### 7.1. pi-driver

pi-driver is the clearest first consumer because its current recovery path is still host-owned. It likely needs a registered port that projects folded `AgentTurn[]` into pi `Message[]` (and perhaps rebuilt system-context inputs) without importing Huabu route code into the subtree.

### 7.2. ACP driver

ACP should continue to prefer native `session/load` when a valid `sessionId` exists. The same Agenetes recovery seam can still serve ACP later when a session id is stale, missing, or otherwise unusable and a driver-managed replay strategy is needed.

### 7.3. Forking

Thread forking should not be a custom built-in-only history-copy trick. It should become an Agenetes operation that realizes a new `threadId` from a source durable thread, letting each driver decide whether that means cloning native state, replaying durable turns, or starting a fresh runtime with projected seed state.

The current direction is that forking should require a **new target spec**, not blindly clone the source thread's persisted spec. Some merge or inheritance rules may still exist, but they are likely to be at least partly **driver-specific** rather than one rigid cross-driver rule.

## 10. Planned subtasks

### ⚪ Define a generic recovery/fork vocabulary and runtime seam

Decide whether recovery extends `create(...)`, adds a new instance surface, or introduces a separate realization API.

- ⚪ Decide whether recovery stays implicit inside Deployment realization or still needs a first-class runtime operation.
- ⚪ Decide what durable inputs flow through Agenetes into the driver.
- ⚪ Preserve the fallback-ladder semantics instead of collapsing recovery into immediate replay.

### ⚪ Specify pi-driver history projection port(s)

This needs a host-injected port rather than subtree imports of Huabu prompt builders.

- ⚪ Define the minimal projection port from folded `AgentTurn[]` into pi-native recovery input.
- ⚪ Keep host-specific prompt assembly out of the subtree package.

### ⚪ Move built-in cold-start replay out of `agent.route.ts`

The target is to remove route-level `priorTurns -> resumeThreadContext(...)`.

- ⚪ Delete host-route ownership of built-in recovery replay.
- ⚪ Re-home cold-start recovery behind an Agenetes-managed seam and policy.
- ⚪ Make the built-in path enter the same recovery ladder as other drivers instead of keeping a route-local fallback.

### ⚪ Define Agenetes-level thread fork semantics for all drivers

This needs to cover source thread, target thread, spec derivation, and durable record behavior.

- ⚪ Define the source/target thread contract.
- ⚪ Define how a fork derives or overrides the new target spec.
- ⚪ Define what durable state is copied, projected, or rehydrated.
- ⚪ Decide which merge/inheritance rules are global and which are driver-specific.

### ⚪ Decide how recovery/fork interacts with `reuse-ignores-spec`

Restoring a broken Deployment and creating a new forked thread are similar but not identical spec/lifecycle operations.

- ⚪ Decide whether same-thread recovery always preserves the persisted spec.
- ⚪ Decide whether forking is allowed to alter spec at realization time.

## 11. Open questions

1. Should recovery remain a purely implicit part of Deployment realization, or does Agenetes still need an explicit internal/runtime recovery operation even if it is not product-facing?
2. What should the instance-level auto-recover policy shape be?
3. What should the cheap recoverability estimate measure: turn count, approximate tokens/size, payload size, or a richer uncertainty score?
4. When recovery exceeds the allowed budget, what is the minimal confirmation/prompt shape worth supporting before the system should just deny?
5. Which parts of a fork's target spec, if any, may be inherited or merged from the source thread, and which parts must be supplied fresh?
6. Where should opaque driver-native recovery blobs live if `AgentStateSnapshot.metadata` remains user-facing rather than driver-facing?
7. Can one recovery seam cover both same-thread restore and new-thread fork cleanly, or do they diverge enough to justify separate APIs?
