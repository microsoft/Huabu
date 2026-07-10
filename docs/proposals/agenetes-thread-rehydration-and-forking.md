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

## 5. Candidate layering

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

## 6. Candidate seam

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

## 7. Driver implications

### 7.1. pi-driver

pi-driver is the clearest first consumer because its current recovery path is still host-owned. It likely needs a registered port that projects folded `AgentTurn[]` into pi `Message[]` (and perhaps rebuilt system-context inputs) without importing Huabu route code into the subtree.

### 7.2. ACP driver

ACP should continue to prefer native `session/load` when a valid `sessionId` exists. The same Agenetes recovery seam can still serve ACP later when a session id is stale, missing, or otherwise unusable and a driver-managed replay strategy is needed.

### 7.3. Forking

Thread forking should not be a custom built-in-only history-copy trick. It should become an Agenetes operation that realizes a new `threadId` from a source durable thread, letting each driver decide whether that means cloning native state, replaying durable turns, or starting a fresh runtime with projected seed state.

## 8. Planned subtasks

| Subtask | Status | Notes |
| --- | --- | --- |
| Define a generic recovery/fork vocabulary and runtime seam | **Not started** | Decide whether recovery extends `create(...)`, adds a new instance surface, or introduces a separate realization API. |
| Specify pi-driver history projection port(s) | **Not started** | Needs a host-injected port rather than subtree imports of Huabu prompt builders. |
| Move built-in cold-start replay out of `agent.route.ts` | **Not started** | The target is to remove route-level `priorTurns -> resumeThreadContext(...)`. |
| Define Agenetes-level thread fork semantics for all drivers | **Not started** | Needs to cover source thread, target thread, spec derivation, and durable record behavior. |
| Decide how recovery/fork interacts with `reuse-ignores-spec` | **Not started** | Restoring a broken Deployment and creating a new forked thread are similar but not identical spec/lifecycle operations. |

## 9. Open questions

1. Should recovery be modelled as an extension of `create(spec, priorState)` or as a first-class Agenetes operation distinct from plain create/get?
2. Should a forked thread copy the source thread's persisted `spec` wholesale, or should the host always provide a fresh target spec derived from the source?
3. Where should opaque driver-native recovery blobs live if `AgentStateSnapshot.metadata` remains user-facing rather than driver-facing?
4. Can one recovery seam cover both same-thread restore and new-thread fork cleanly, or do they diverge enough to justify separate APIs?
