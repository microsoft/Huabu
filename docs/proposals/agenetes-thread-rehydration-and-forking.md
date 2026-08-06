# Agenetes Thread Rehydration and Forking

> Unify recovery-only replay and thread forking under one Agenetes-managed model for realizing live agent state from durable thread state.
>
> Status: **Shipped** · Last updated 2026-07-11

---

## 1. Context

The main Huabu built-in chat path now runs as a live pi-driver `Deployment`, not as a per-turn fresh-Job replay loop. That cutover exposed one remaining boundary problem: on cold start or restart, the host route still loads `priorTurns` and rebuilds pi context itself instead of letting Agenetes own recovery.

At the same time, issue [#285](https://github.com/hai-team/Huabu/issues/285) asks for thread forking to become standard behavior across all agents rather than a built-in-only feature, and issue [#295](https://github.com/hai-team/Huabu/issues/295) tracks moving recovery-only replay into Agenetes-managed recovery.

These are not identical product features, but they are the same systems problem family: given durable thread state, how does Agenetes realize a live runtime again, either for the same `threadId` or for a new one?

## 2. Goals

1. Define a driver-agnostic Agenetes model for rehydrating a live agent runtime from durable thread state.
2. Design thread forking as a sibling operation to recovery, not as a host-only built-in special case.
3. Remove host-route ownership of history replay for built-in recovery.
4. Preserve the host/L2 boundary: Agenetes supplies durable inputs and shared policy utilities, while each driver decides how to load folded turns into its backend.
5. Treat recovery primarily as an automatic lifecycle behavior, while keeping fork as an explicit operation.

## 3. Non-goals

This proposal does not reintroduce per-turn replay for normal live conversations.

This proposal does not require every driver to recover in the same way. ACP may prefer session resume; pi may rebuild runtime state from durable turns; other drivers may use different native snapshots.

This proposal does not make Agenetes understand host-specific request payloads such as Huabu's `ChatEnvelope` directly. A driver may use a host-provided projection port when needed, but projection is not a mandatory cross-driver recovery seam.

## 4. Unifying model

Recovery and forking are two variants of the same operation:

| Operation | Source durable state | Target live state                                                |
| --------- | -------------------- | ---------------------------------------------------------------- |
| Recovery  | Thread `T`           | Recreate or resume live runtime for the same thread `T`          |
| Forking   | Thread `T`           | Create a new live runtime for a new thread `T'` derived from `T` |

In both cases the runtime may need:

- the target spec
- the source durable `ThreadRecord` (`spec` + `AgentStateSnapshot`)
- folded turn history (`AgentTurn[]`)

The important boundary is that Agenetes decides **when** rehydration is needed and **which durable facts** are supplied to the driver, while each driver decides **how** to rebuild its backend-native runtime.

The current `priorState` term is intentionally narrower than "all durable recovery input". Today it only carries the persisted `AgentStateSnapshot` down-fed from the thread store (currently `sessionId?` plus `metadata?`). It is useful for native same-thread resume, but it is not by itself sufficient for history-based recovery or fork-from-history. This proposal therefore replaces that narrow argument with a durable input carrying the full source `ThreadRecord` plus materialized turns.

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

The same realization model should also distinguish three cases cleanly:

- **fresh create**: no durable source thread is supplied
- **same-thread realization**: the source durable identity and target identity are the same, so the goal is recovery
- **cross-thread realization**: the source durable identity and target identity differ, so the goal is fork

The comparison should be based on durable thread identity, ideally `(namespace, threadId)`, not on `priorState` alone. `priorState` does not itself encode thread identity.

## 6. Candidate layering

The likely ownership split is:

| Layer                                              | Responsibility                                                                                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host (`apps/server`)                               | Supplies optional host-specific ports only when a driver chooses to use them; it does not orchestrate replay in route code.                                                                        |
| Agenetes instance/runtime                          | Owns recovery/fork orchestration, reads durable thread state, and passes recovery inputs to drivers.                                                                                               |
| Driver (`pi-driver`, `acp-driver`, future drivers) | Owns its realization flow and decides how to load folded turns: native transcript seed, textual serialization, combined first run, optional projection port, or another backend-specific strategy. |

This means the current Huabu route-level sequence:

```text
history() -> priorTurns -> resumeThreadContext() -> runAgent()
```

should eventually become something closer to:

```text
create-or-recover(spec) -> driver-owned rehydration -> run()
```

with turn loading owned inside the driver rather than route code.

## 7. Recovery policy and uncertainty budget

Automatic recovery should not mean unconditional replay. Recovery is only safe when the system has enough confidence that durable state can be rehydrated without silently drifting semantics too far.

The policy applies when a durable thread record exists but no live handle exists. The driver should prefer native resume (`session/load`, snapshot restore, etc.) before history-based recovery, and history-based recovery is gated by the instance-level safe limit.

The key risk is not just turn count, but **recovery uncertainty**. A long replay may trigger harness compaction, truncation, or other backend-native behaviors whose effect is not fully predictable. So the gating threshold should likely be framed as a **recoverability budget**, not a single boolean.

For now, the design direction is to use a **cheap estimation** only. This is a heuristic recoverability gate, not billing-grade token accounting and not a precise tokenizer-backed budget system.

The threshold values themselves should be configurable. The current direction is to place that configuration at the **Agenetes instance level** during mount and to name the primary gate with a size/limit-style concept rather than a token-accounting one.

When no override is supplied, `mountAgenetes()` enables automatic recovery with `safeHistoryLoadLimit: 10_000` and `onThresholdExceeded: 'deny'`.

The current minimal policy shape is:

```ts
interface AutoRecoverPolicy {
  enabled: boolean;
  safeHistoryLoadLimit: number;
  onThresholdExceeded: 'confirm' | 'deny';
  confirm?: (context: RecoveryConfirmationContext) => Promise<boolean>;
}
```

Its semantics are intentionally simple:

- if the cheap recovery estimate is `<= safeHistoryLoadLimit`, Agenetes may load history automatically
- if the estimate is `> safeHistoryLoadLimit`, Agenetes follows `onThresholdExceeded`
- `confirm` calls the mount-time handler; a missing handler safely degrades to `deny`

The `limit` is interpreted through a documented cheap estimation formula rather than a precise tokenizer result. The first version measures only the folded turn log:

```ts
textualBytes = sum(Buffer.byteLength(JSON.stringify(turn), 'utf8'));
```

It then applies the first-pass heuristic:

```ts
estimatedWords = textualBytes / 6;
estimatedTokens = estimatedWords / 0.75;
// simplified:
estimatedTokens = textualBytes / 4.5;
```

This should be read as a conservative heuristic pipeline:

- derive a cheap textual size signal from serialized folded `AgentTurn`s
- approximate words from that size
- approximate token-like cost from the word count

It is intentionally not a tokenizer-accurate result and not suitable for billing/accounting use cases. Its only purpose is deciding whether auto-recovery is comfortably small enough to proceed without confirmation.

For the first version, this formula is the default recoverability heuristic unless later implementation evidence shows it is too weak or too conservative.

When recovery exceeds the safe automatic budget, `deny` fails fast. `confirm` delegates to the mount-time host handler; refusal or no installed handler returns a structured denial, while handler failures propagate as real errors.

## 8. Candidate seam

The current runtime seam already down-feeds `priorState` into `driver.create(spec, priorState)`. That is enough for native same-thread resume flows such as ACP `session/load`, but it is not enough for history-based recovery or fork-from-history because it does not carry source-thread identity or the wider durable inputs the fallback ladder may need.

The current design direction is **not** to force every driver through the same decomposed recovery sub-methods (`tryResume`, `tryRealizeFromHistory`, and so on). Those boundaries are likely too backend-specific to standardize cleanly.

Instead, the preferred direction is:

- **Agenetes provides shared, driver-agnostic utilities** for realization classification, same-thread vs fork detection, cheap estimation, threshold/policy checks, and confirm/deny handling.
- **Each driver owns its realization flow through the concrete `AgentHandle` it creates**. The driver should leverage the strongest history-loading mechanism its harness provides: it may seed turns directly while constructing native state, resume a native session, defer asynchronous loading until the handle is first used, combine recovery material with the first real run, or choose another backend-specific strategy.

For the first version, recovery should therefore remain **implicit inside the driver-owned handle lifecycle**, not split into a separate Agenetes runtime recovery operation.

In that model, the important standardization target is not a rigid sequence of recovery sub-methods, but:

- the shape of the durable realization input
- the shared helper/policy utilities
- the expectation that the driver-created handle realizes fresh create, same-thread recovery, or fork from that input using the best mechanism available to its harness

The minimal extension should therefore replace the second input to `create(...)`, rather than teaching route handlers to read `history()` and replay manually.

The first-version shape is:

```ts
interface ThreadIdentity {
  readonly namespace: Namespace;
  readonly threadId: string;
}

interface AgentDurableInput<TSpec = unknown> {
  readonly source: ThreadIdentity;
  readonly record: {
    readonly spec: TSpec;
    readonly state: AgentStateSnapshot;
  };
  readonly turns: readonly ObservedAgentTurn[];
}
```

`AgentDurableInput<TSpec>` belongs in `@agenetes/runtime` alongside `AgentDriver`, using only types imported from `@agenetes/protocol`. `@agenetes/agenetes` constructs it from `ThreadStore` and `TurnStore`; runtime must not import the higher-level instance package. `ThreadRecord` may reuse or alias the durable record member shape. The dependency direction remains:

```text
@agenetes/protocol <- @agenetes/runtime <- @agenetes/agenetes
```

Here `spec` remains the **target** realization spec. `AgentDurableInput` identifies and describes the **source** durable thread. That gives Agenetes enough information to distinguish:

- no durable input → fresh create
- source identity equals target identity → same-thread recovery
- source identity differs from target identity → fork

For same-thread recovery, the source `ThreadRecord.spec` is authoritative. Automatic recovery must not silently absorb a newly compiled or otherwise drifted incoming spec after a process restart. Applying configuration changes requires an explicit thread recreation or a new thread, preserving `reuse-ignores-spec` semantics across both live reuse and restart recovery.

The durable data is wrapped in a create-time context so instance-level recovery policy does not contaminate `AgentDurableInput`:

```ts
interface AgentCreateContext<TSpec = unknown> {
  readonly durableInput?: AgentDurableInput<TSpec>;
  readonly recovery: {
    authorizeHistoryLoad(input: {
      mode: 'recover' | 'fork';
      turns: readonly ObservedAgentTurn[];
    }): Promise<HistoryLoadAuthorization>;
  };
}

type HistoryLoadAuthorization =
  | {
      readonly allowed: true;
      readonly estimatedSize: number;
    }
  | {
      readonly allowed: false;
      readonly code:
        | 'auto_recover_disabled'
        | 'safe_limit_exceeded'
        | 'confirmation_unavailable'
        | 'confirmation_declined';
      readonly estimatedSize: number;
      readonly safeLimit: number;
    };

create(
  targetSpec: TSpec,
  context: AgentCreateContext<TSpec>,
): AgentHandle;
```

The Agenetes instance constructs `context.recovery` from its mount-time `AutoRecoverPolicy`. A driver/handle calls `authorizeHistoryLoad(...)` only after its stronger native resume strategy is unavailable or has failed. The service encapsulates cheap estimation, `safeHistoryLoadLimit`, confirmation, and deny behavior, so drivers do not duplicate or reinterpret instance policy.

Expected policy denial is a structured result, not an exception. The handle can surface the denial code as an explicit recovery error. Unexpected failures from the confirmation handler or policy infrastructure propagate as real errors rather than being silently converted into denial.

`enabled` controls automatic same-thread recovery only. An explicit fork may still load source turns when auto-recovery is disabled; it bypasses only the `enabled` gate and remains subject to the shared `safeHistoryLoadLimit` plus confirm/deny behavior.

Turn-loading timing is deliberately not standardized. A harness that can directly seed native transcript state should do so. A driver that must perform asynchronous resume or prompt-based loading may retain private bootstrap state (for example, `turnsToLoad`) and consume it when the handle is first used. `AgentTurnState.isFirstMessage` remains only a render hint about the current backend session; it does not carry durable history or prescribe when history is loaded.

The realization input uses the same snapshot materialization as `history({ withTail: true })`: completed Tier-2 turns plus an optional `{ ...AgentTurn, isIncomplete: true }` projection of the uncovered Tier-1 suffix. Tier 1 records an internal `turn_start` carrying the request before the yielded events, so the projected turn has the same request/transcript envelope as a completed turn without being appended to Tier 2. The independent `tail()` surface continues to serve raw live-event reconnect.

The important design rule is that folded turns and the source thread record flow **through Agenetes into the driver**, not around Agenetes through host route code.

One consequence of the current direction is that a future recovery design may not need to expose a public `recover(...)` call at all. Instead, Agenetes may only need:

- an internal realization/recovery seam
- shared driver-agnostic helper utilities
- a configurable auto-recover policy
- a separate explicit fork operation

## 9. Driver implications

### 9.1. pi-driver

pi-driver is the clearest first consumer because its current recovery path is still host-owned. For the first version, it serializes folded turns into a synthetic pi recovery message and seeds that message through pi-agent-core's native `Agent.initialState.messages` support. The first real `run()` then appends only the current request. This requires no host projection port and creates no extra recovery run. The cross-driver contract still does not prescribe this strategy for other drivers.

### 9.2. ACP driver

ACP should continue to prefer native session resume/load when a valid `sessionId` exists. For same-thread recovery, only a missing, invalid, or unsupported native session is eligible for history fallback; worker unavailability, authentication failure, invalid recipe, and similar operational errors remain hard failures.

When native recovery is unavailable, ACP requests history-load authorization, creates a fresh session without the stale source `sessionId`, serializes the folded turns, and prepends that recovery material to the first real prompt. Fork follows the same fresh-session + first-real-prompt history load path directly. ACP does not execute a separate bootstrap prompt, avoiding extra model output, tool side effects, and conversation-log pollution.

Safe fallback requires a structured `session_resume_unavailable` reason propagated from agentlet session bootstrap through the spawn RPC into the ACP driver. The driver must never infer fallback eligibility by matching error text. Missing/unsupported native sessions map to this reason; worker, authentication, recipe, transport, and unknown failures remain hard errors. Because this propagation touches `external/agentlet/`, its change must be committed separately from Agenetes/Huabu changes.

### 9.3. Forking

Thread forking should not be a custom built-in-only history-copy trick. It should become an Agenetes operation that realizes a new `threadId` from a source durable thread, letting each driver decide whether that means cloning native state, replaying durable turns, or starting a fresh runtime with projected seed state.

Forking requires a **complete target spec**, not a partial patch or a blind clone of the source thread's persisted spec. The host compiles every target field, including `threadId`, `namespace`, `kind`, `workloadType`, and driver-specific options. The target `threadId` must be fresh.

The first-version operation is therefore:

```ts
fork(sourceIdentity, targetSpec);
```

Agenetes performs no field-level merge and maintains no ad-hoc list of identity or option fields. It validates source existence, target freshness, and identity separation, then gives the target driver the complete target spec plus source durable input.

The current default direction is also that first-version forking should **not** blindly inherit driver-native `priorState` into the new thread. `priorState` primarily serves same-thread recovery; a new thread should be realized from the source spec/history model unless a driver later defines a safe, explicit native-state clone rule.

## 10. Planned subtasks

### ✅ Define a generic recovery/fork vocabulary and runtime seam

Replace the narrow `create(spec, priorState)` down-feed with the agreed create context, durable input, and shared authorization utilities.

- ✅ Carry source durable identity separately from target spec so same-thread recovery and fork are unambiguous.
- ✅ Durable input is source identity + `ThreadRecord` + materialized `ObservedAgentTurn[]`.
- ✅ Place `AgentDurableInput<TSpec>` in `@agenetes/runtime` without introducing a runtime → instance dependency.
- ✅ Wrap durable input and instance services in `AgentCreateContext<TSpec>`.
- ✅ Implement instance-provided recovery authorization and remaining shared utilities.
- ✅ Preserve the fallback-ladder semantics instead of collapsing recovery into immediate replay.

### ✅ Implement pi-driver turn loading

pi-driver should load folded turns inside its own realization flow without importing Huabu route code into the subtree.

- ✅ First-version strategy: serialized folded turns → synthetic pi message → `Agent.initialState.messages`.
- ✅ Define the synthetic recovery-message format.
- ✅ Keep host-specific prompt assembly out of the subtree package.
- ✅ No projection port is required for the first version.

### ✅ Implement ACP fallback turn loading

- ✅ Prefer native session resume/load for same-thread recovery.
- ✅ Fall back only for missing, invalid, or unsupported native sessions; unrelated operational failures remain hard errors.
- ✅ First-version fallback: serialized folded turns are prepended to the first real ACP prompt.
- ✅ Propagate structured `session_resume_unavailable` from agentlet bootstrap through spawn RPC.
- ✅ Do not use error-text matching for fallback classification.
- ✅ Create a fresh ACP session without the stale source `sessionId` before loading history.

### ✅ Move built-in cold-start replay out of `agent.route.ts`

The target is to remove route-level `priorTurns -> resumeThreadContext(...)`.

- ✅ Delete host-route ownership of built-in recovery replay.
- ✅ Re-home cold-start recovery behind an Agenetes-managed seam and policy.
- ✅ Make the built-in path enter the same recovery ladder as other drivers instead of keeping a route-local fallback.

### ✅ Define Agenetes-level thread fork semantics for all drivers

This needs to cover source thread, target thread, spec derivation, and durable record behavior.

- ✅ Define the source/target thread identity contract as `(namespace, threadId)`.
- ✅ L1 supplies a complete target spec; Agenetes performs no field-level merge.
- ✅ Fork carries materialized source turns, including an optional incomplete tail projection, but does not inherit driver-native `priorState`.
- ✅ No driver-specific merge hook; target-spec compilation belongs to L1.

### ✅ Implement the Agenetes thread fork operation

- ✅ Reject a missing source record or an already-existing target identity.
- ✅ Accept the complete host-compiled target spec without field-level composition.
- ✅ Create the target handle with source durable input so the driver classifies it as a fork.
- ✅ Persist the fresh target record without inheriting source driver-native state; source turns seed the target driver's native context and are not copied into the target Tier-2 log.

### ✅ Decide how recovery/fork interacts with `reuse-ignores-spec`

Restoring a broken Deployment and creating a new forked thread are similar but not identical spec/lifecycle operations.

- ✅ Same-thread recovery uses the source `ThreadRecord.spec`; configuration drift requires explicit recreation/new thread.
- ✅ Forking uses the complete target spec supplied by L1.

## 11. Future / backlog

- Per-driver auto-recover policy overrides; the first version has instance-level configuration only.
- A second hard recovery limit; the first version has one safe limit plus confirm/deny.
- Opaque `driverState` in `AgentStateSnapshot`; add it only when a concrete driver needs more than `sessionId + metadata`.
- Driver-specific native-state cloning; add it only when a concrete driver cannot use the common history model.
