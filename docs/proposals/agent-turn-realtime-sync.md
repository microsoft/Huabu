# Agent Turn Real-Time Sync

Status: In-Progress

Last updated: 2026-08-14

Tracking issue: [#75](https://github.com/microsoft/Huabu/issues/75)

## Context

An Agent Node conversation that is already open in Web does not attach to a new turn started through RFS or another headless entry point. The turn may emit many `tool_call`, `tool_call_update`, and `text_delta` events, but the watching tab commonly sees no incremental progress until the turn finishes and history is loaded again.

The server-side execution path is already incremental. Internal pi-agent-core turns and external ACP turns yield `AgentStreamEvent` frames as work happens; Agenetes appends every yielded frame to the Tier-1 event log before forwarding it; `POST /api/agent` writes each frame to SSE immediately; and Web's `handleStreamEvent` incrementally updates assistant text and tool parts.

The missing behavior is live discovery and attachment for turns that the current tab did not start. The route-local `activeRuns` map only tracks `POST /api/agent`, Canvas Sync carries canvas mutations rather than conversation events, and `useChatHistory` attempts reconnect only after initial history loading when the last loaded message looks incomplete. That page-refresh path is not yet a complete baseline: the history route reads folded Tier-2 turns without `{ withTail: true }`, while Web messages are intentionally not persisted, so a refresh cannot reliably recover the current incomplete user turn needed to trigger reconnect.

This proposal defines how UI-, RFS-, and Headless-initiated turns share one active-run registry and one durable event stream, and how an already-open Web conversation attaches without duplicating messages or tool cards.

## Relationship to existing designs

- [Agent Architecture](../architecture/agent-architecture.md) remains authoritative for Agent execution, `AgentStreamEvent`, Agenetes durability, and UI/RFS invocation through `AgentThreadService`.
- [Canvas Real-Time Sync](../architecture/canvas-realtime-sync.md) remains authoritative for canvas snapshots, deltas, lifecycle node patches, heartbeat, and reconnect behavior.
- [Canvas Collaboration Sync](./canvas-realtime-sync-plan.md) continues to own Canvas Sync reliability work, including snapshot/subscribe ordering, heartbeat, and automatic reconnect.
- [Headless Executor & Sync](./headless-executor-plan.md) records the server-side canvas executor design; it does not own Agent conversation event delivery.
- Issue [#75](https://github.com/microsoft/Huabu/issues/75) remains the implementation and acceptance tracker. This proposal records the cross-layer design decisions.

## Goals

1. A Web conversation that is already open attaches to a new turn started through UI, RFS, Headless, or another tab.
2. Every attached tab renders `tool_call`, `tool_call_update`, thinking, text, plan, error, and terminal events while the turn is running.
3. One producing turn supports multiple independent consumers without any consumer owning or draining the producer's event stream.
4. History loading, live replay, reconnect, and terminal convergence do not duplicate or permanently omit messages or tool parts.
5. A disconnected or background tab eventually converges to durable history without requiring a manual page refresh.
6. Existing UI-initiated turn streaming remains behaviorally unchanged.

## Non-goals

- Adding percentage, byte-count, or stage progress inside one long-running tool through pi-agent-core's `onPartial` callback.
- Moving conversation event payloads onto the Canvas Sync stream.
- Replacing Agenetes Tier-1/Tier-2 conversation durability.
- Persisting active-run state across server restarts; after restart, durable incomplete-turn recovery remains the source of truth.
- Multi-device or cloud pub/sub beyond the current single-process desktop topology.
- Discovering a source-canvas turn while viewing only a cross-canvas World `nodeRef`; this proposal's lifecycle trigger requires the fixed Agent Node's owner canvas to be the actively synchronized canvas.

## Current flow and failure

```text
UI POST /api/agent ──► AgentThreadService.invoke ──► Agenetes Tier-1 log
       │                         │                            │
       └── owns POST SSE ◄───────┴── yielded events           └── tail()

RFS prompt ─────────► AgentThreadService.invoke ──► Agenetes Tier-1 log
       └── owns RFS response SSE

already-open Web tab ── no new-turn signal / no activeRuns entry ──► no tail
```

`external/agenetes/packages/agenetes/src/instance.ts#createTail` already subscribes before reading persisted backfill, buffers concurrent appends, deduplicates by sequence, and supports multiple subscribers. A second host-side event buffer or fan-out implementation would duplicate a capability that already exists.

## Proposed architecture

### 1. `AgentThreadService` owns active invocation state

Move active-run ownership out of `agent.route.ts` and into `AgentThreadService`, which already owns the shared turn lease, abort controller, dispatch, and terminal settlement for UI and RFS invocation.

The registry remains keyed by `threadId`, matching the existing turn lease, abort controller, stop route, Agenetes runtime handle, and event-bus ownership. Each entry also records the owner `canvasId`; `/api/agent/stream/:threadId` validates a supplied canvas against that owner before deriving the Agenetes namespace.

An active entry contains only transient control data:

```ts
interface ActiveAgentInvocation {
  canvasId?: string;
  abortController: AbortController;
  turnStarted: Promise<boolean>;
}
```

Registration happens after the turn lease is acquired but before a fixed Agent Node publishes its `running` lifecycle patch. If lifecycle start fails, registration and the lease are released together. Settlement removes the active entry only after the invocation generator and durable turn fold have completed.

`AgentThreadService` exposes active lookup used by `/api/agent/stream/:threadId`; the existing stop path continues resolving by globally unique `threadId`. UI and RFS routes do not register runs independently.

**Decision:** the active registry is process-local. It represents execution ownership, not durable conversation state, and therefore lives beside the turn lease and abort controller in `AgentThreadService`. After a process restart, incomplete Tier-1 history may be recovered as history but is not reported as an active run.

The registry also exposes a per-invocation `turnStarted` barrier. Internal and ACP dispatch resolve it to `true` immediately after the decorated Agenetes handle creates the Tier-1 turn-start record. Active history reads wait for this barrier before reading `{ withTail: true }`; this closes the race where the persisted node reaches `running` before the lazy invocation generator has created the durable user turn. Disposal, startup failure, or abort before turn start resolves it to `false`, so waiting routes converge through inactive/error handling rather than hang or produce an unhandled rejection.

### 2. Agenetes Tier-1 tail is the live fan-out

`GET /api/agent/stream/:threadId` verifies that the requested `(canvasId, threadId)` is active, then streams `agenetes.tail(namespace, threadId)`.

The RFS response continues consuming `invocation.events` for its caller. Web tail consumers independently observe the same frames from the Tier-1 event log; they do not consume, proxy, or interfere with the RFS response stream.

No new event buffer is added to Huabu. Sequence ordering, subscribe-before-backfill, terminal completion, and multi-consumer delivery stay inside Agenetes.

### 3. Web uses one per-thread attachment coordinator

Extract reconnect ownership from the `useChatHistory` effect into a Web-side coordinator with an operation equivalent to:

```ts
attachThreadRun({ canvasId, threadId, conversationView });
```

The coordinator maintains one in-memory attachment per `(canvasId, threadId)` in the current tab. The attachment is registered before the HTTP request starts, so repeated lifecycle updates cannot open duplicate streams during the interval before the first event arrives.

The coordinator reuses `handleStreamEvent` from `useAgentStream` so normal POST streaming, reconnect replay, and external-turn attachment share the same incremental message/tool reducer.

`loadingThreadIds` remains the UI loading projection, not the subscription lock. A separate coordinator-owned map tracks connecting and connected streams. The normal UI `POST /api/agent` path claims the same per-thread consumer slot before it publishes the node's `running` state and releases it on terminal/abort; therefore the lifecycle observer never opens a redundant tail for a turn whose POST stream is already owned by this tab.

### 4. Canvas lifecycle discovers external turns; Agent SSE carries their events

Canvas Sync does not transport `AgentStreamEvent` payloads. Its reliable delivery of the fixed Agent Node's `running` lifecycle state is the trigger that tells an open conversation to call the attachment coordinator.

**Decision:** the persisted `running` state of the conversation owner node is the canonical discovery signal. This proposal does not add a Canvas Sync `thread_run` event or an idle cross-turn Agent SSE subscription. The signal is an idempotent prompt to attempt attachment, not proof that the run is still active; `AgentThreadService` remains authoritative for the active lookup.

The currently viewed conversation owner is observed reactively. When its node is `running`, Web attempts attachment even if `historyLoadedThreads` already contains the thread. This also provides recovery after a Canvas Sync reconnect or snapshot reload: observing the materialized node in `running` state is sufficient to retry attachment without requiring the original transition frame.

**Decision:** each tab automatically attaches only its actively visible conversation. When an external lifecycle update concerns a thread that is not open, Web invalidates that thread's history cache but does not open an Agent SSE connection or maintain a partial background transcript. The next open loads durable history and attaches if the owner is still `running`.

### 5. History and live events converge through one attachment transaction

An external Agent SSE stream does not currently carry the initiating user message. Before applying live replay, the coordinator refreshes history to materialize the new external user turn from Agenetes' durable turn start. The history route reads `agenetes.history(namespace, threadId, { withTail: true })`; when the run is active it first waits for the active registry's `turnStarted` barrier so a `running` lifecycle update cannot race ahead of the incomplete user turn.

**Decision:** every externally discovered live attachment refreshes history before opening the Tier-1 tail. This proposal does not add a user or turn-start event to `AgentStreamEvent`. The additional history request is accepted in exchange for preserving one canonical event protocol and presenting a complete user-before-assistant transcript.

The coordinator then keeps history through the last user message and discards any partial assistant/status suffix for the active turn before applying the Tier-1 replay under one fresh assistant message ID. This preserves the existing reconnect behavior while preventing partial history and replay from rendering the same assistant/tool content twice.

**Decision:** reconnect uses full replacement of the current incomplete turn rather than incremental cursor resume. Each attachment starts `agenetes.tail` at the current Tier-2 fence, clears the current turn's assistant/status projection, and deterministically rebuilds it from the complete Tier-1 suffix. Tier-1 sequence numbers remain internal to Agenetes.

If the run becomes inactive before the live stream is established, the coordinator performs one final history refresh instead of reporting success-shaped completion. Durable Tier-2 history is the terminal fallback.

On a successful terminal event, the live projection is already complete. The history cache remains valid for the current tab; a later explicit reload can reconstruct the same transcript from Tier-2 history.

**Decision:** a healthy live attachment that receives the turn's terminal event keeps `historyLoadedThreads` valid. Background turns, missing terminal events, unrecoverable stream failures, and inactive responses without a complete local projection invalidate the thread and converge through durable history on the next open or immediate recovery path.

### 6. Stream failures are distinguishable

`agentApi.reconnectStream` currently maps inactive runs, transport failures, aborted requests, and malformed streams to the same `false` result. The attachment coordinator needs distinct outcomes:

```ts
type AgentStreamAttachResult =
  | { status: 'completed' }
  | { status: 'inactive' }
  | { status: 'aborted' };
```

Unexpected HTTP, network, or parsing failures reject with an error. Callers may retry active runs with bounded backoff; they use final history refresh for an inactive run and do nothing for an intentionally aborted attachment.

**Decision:** automatic recovery completes and then reuses the intended page-refresh behavior as its baseline. While the same conversation remains visible and its owner remains `running`, an unexpected Agent SSE termination reruns the same coordinator transaction: refresh incomplete history, clear the incomplete assistant/status projection, and reattach through `/api/agent/stream/:threadId` backed by `agenetes.tail()`. No second reconnect protocol or cursor mechanism is introduced.

### 7. Canvas Sync reliability is a prerequisite

Issue #75's Canvas Sync fixes ship with or before external-turn attachment:

- subscribe before reading/sending the initial version boundary so no mutation is permanently lost between snapshot and subscription;
- emit periodic heartbeat comments;
- reconnect with bounded exponential backoff after unexpected stream completion or parse/network failure;
- reconcile from snapshot/version after reconnect;
- never retry after an intentional canvas switch or disconnect.

The Agent event stream uses the same retry discipline, but its durable recovery source is Agenetes history and Tier-1 tail rather than Canvas delta versions.

## Web attachment state machine

```text
idle ── owner status=running ──► refreshing-history ──► attaching
 ▲                                      │                   │
 │                                      └── inactive ──────► final-refresh
 │                                                          │
 ├── terminal / inactive ◄── streaming ◄────────────────────┘
 │                           │
 └── close/switch ◄── intentional abort
```

Only one state-machine instance exists per `(canvasId, threadId)` in a tab. Duplicate `running` observations return the existing attachment promise.

## Delivery sequence

1. Move active invocation ownership into `AgentThreadService`; add the Tier-1 turn-start readiness barrier; switch `/agent/stream/:threadId` and stop lookup to the shared registry.
2. Make active history reads wait for readiness and include the Tier-1 suffix through `{ withTail: true }`, completing the existing page-refresh recovery path.
3. Add server tests proving that RFS invocation is attachable, incomplete history contains the active user turn, and two `agenetes.tail` consumers receive the same ordered events.
4. Extract the Web attachment coordinator; route both the normal UI POST consumer claim and page-refresh reconnect ownership through it.
5. Trigger attachment from the open conversation owner's `running` state and invalidate cached history for non-open external threads.
6. Distinguish inactive, aborted, and failed Agent stream outcomes; add bounded automatic reattachment by reusing the page-refresh transaction.
7. Fix Canvas Sync snapshot/subscribe ordering, heartbeat, and automatic reconnect.
8. Add multi-tab, disconnect, terminal-race, and duplicate-suppression coverage.
9. Fold shipped behavior into Agent Architecture and Canvas Real-Time Sync, then mark this proposal Shipped.

## Implementation plan

### Phase 1 — Server invocation ownership and readiness

1. Replace the route-local `activeRuns` map with an `AgentThreadService` registry keyed by `threadId` and carrying the owner `canvasId`, abort controller, start time, and per-invocation `turnStarted` barrier.
2. Register before `agentNodeLifecycle.start`; remove the matching entry only after settlement and Tier-2 fold. Use invocation identity when clearing so stale cleanup cannot remove a later run.
3. Add an optional internal `onTurnStarted` callback to built-in and ACP dispatch. Resolve it immediately after `handle.run(...)` has synchronously created the decorated Agenetes Tier-1 turn-start entry; reject the service barrier if startup settles before that callback.
4. Make `/agent/stream/:threadId` validate the requested owner canvas through the service registry, await readiness, and then use the existing `agenetes.tail(namespace, threadId)`.
5. Keep stop semantics thread-based and service-owned; remove route-owned completion flags and cleanup timers.

### Phase 2 — Incomplete history recovery

1. Change the history route to request `{ withTail: true }`, waiting for `turnStarted` first when the service reports an active run.
2. Verify `buildHistoryFromTurns` projects an incomplete turn as one user message plus any currently persisted assistant/tool suffix; add projection coverage where missing.
3. Preserve folded Tier-2-only behavior when no suffix exists. A crashed incomplete suffix is history, not an active run.
4. Add the race test: lifecycle reaches `running`, history is requested before lazy dispatch starts, readiness releases after Tier-1 turn start, and the response includes the initiating user prompt.

### Phase 3 — One Web consumer coordinator

1. Extract the page-refresh reconnect transaction from `useChatHistory` into a module-scoped per-thread coordinator with `claimPostStream`, `attach`, and `release` ownership.
2. Register ownership before network work. The existing UI `startStream` claims the POST consumer slot before writing `running`; an external attachment claims the same slot before its history request.
3. Implement the chosen replacement replay: refresh incomplete history, keep through the current user message, drop the active assistant/status suffix, create one assistant ID, and feed all tail events through `handleStreamEvent`.
4. Return structured `completed`, `inactive`, and `aborted` outcomes from `agentApi.reconnectStream`; reject unexpected HTTP, network, and parse failures.
5. Keep `loadingThreadIds` as presentation state while the coordinator map is the authoritative single-consumer lock.

### Phase 4 — Lifecycle-triggered attachment and cache policy

1. Observe the actively visible fixed Agent Node's conversation-owner data. If it is `running` and this tab has no consumer claim, invoke the coordinator.
2. When Canvas Sync applies lifecycle changes for a non-visible Agent Node, call a canonical `invalidateThreadHistory(threadId)` action without opening a stream.
3. On a healthy terminal event, retain `historyLoadedThreads`. On background, incomplete, inactive-without-terminal, or unrecoverable paths, invalidate and converge through history.
4. Abort and release attachment ownership on conversation close, thread switch, canvas switch, explicit stop, and component teardown.

### Phase 5 — Reliability and convergence

1. In the Canvas Sync route, subscribe before obtaining/sending the snapshot version so writes at the handshake boundary are buffered and deduplicated rather than lost.
2. Add server heartbeat comments and client reconnect with bounded exponential backoff, reset after a healthy connection.
3. Reuse the same bounded-backoff discipline for Agent stream reattachment while the same conversation remains visible and its owner remains `running`.
4. Ensure intentional abort never schedules reconnect. A confirmed inactive Agent run performs final history convergence rather than retrying.

### Phase 6 — Verification and documentation

1. Cover UI, RFS create, RFS prompt, multi-tool internal turns, ACP turns, two tabs, one-tab disconnect, repeated `running`, terminal-during-attach, and server inactive races.
2. Assert no duplicate user message, assistant text, plan, status row, or tool card after replay and repeated reconnect.
3. Assert one consumer disconnect does not abort or drain the producer or another consumer.
4. Update `agent-architecture.md` and `canvas-realtime-sync.md`; mark this proposal Shipped only after issue #75's acceptance criteria pass.

## Estimated impact

| Area                        | Expected files | Risk                                                                    |
| --------------------------- | -------------: | ----------------------------------------------------------------------- |
| Agent service and routes    |            3–5 | Medium: registration/settlement ordering and namespace correctness      |
| Web stream/history/store    |            4–7 | Medium-high: replay/history deduplication and React lifecycle ownership |
| Canvas Sync reliability     |            2–4 | Medium: reconnect cancellation and version reconciliation               |
| Shared API types            |            0–2 | Low unless an explicit lifecycle event is selected                      |
| Agenetes subtree            |              0 | Existing `tail` behavior is reused                                      |
| Tests and architecture docs |           5–10 | Low-medium                                                              |

The implementation is cross-layer but does not require a new persistence system or a new conversation event protocol.

## Acceptance criteria

- With an Agent Node conversation already open and history loaded, an RFS/Headless turn containing several sequential tool calls renders each tool start, completion, and intervening text before the turn finishes.
- A new RFS-created Agent Node appears and progresses from `running` to its terminal state without a page refresh.
- Two open tabs receive the same external turn while one tab disconnecting does not interrupt the RFS caller or the other tab.
- Repeated `running` observations, reconnect, and Tier-1 backfill do not duplicate user messages, assistant text, plans, or tool cards within a tab.
- A turn that finishes between history refresh and live attachment converges through final durable history.
- A tab that was not watching the thread loads current history when it later opens the Agent Node.
- Canvas Sync and Agent SSE recover after an unexpected disconnect with bounded backoff and no manual refresh.
- Existing UI-owned POST streaming retains its incremental behavior.

## Risks and mitigations

| Risk                                               | Mitigation                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `running` reaches Web before the run is attachable | Register in `AgentThreadService` before publishing lifecycle start                                            |
| Invocation fails before Tier-1 turn start          | Reject the readiness barrier and return inactive/error rather than leaving history or stream requests pending |
| History refresh and Tier-1 replay overlap          | Trim the active history suffix before replay and keep one assistant ID per attachment                         |
| Turn finishes during attachment                    | Treat inactive as a final-history convergence path                                                            |
| Duplicate React effects open duplicate streams     | Coordinator-level per-thread attachment map registered before fetch                                           |
| Network failures look like normal inactivity       | Return structured attach outcomes and reject unexpected failures                                              |
| Canvas Sync misses the original start transition   | Reconnect snapshot/load exposes the durable node `running` state and retriggers attachment                    |
| One consumer disconnects the producer              | Consumers tail the Tier-1 log independently; producer lifetime remains service-owned                          |

## Resolved questions

### OQ1 — Is Agent Node `running` state the canonical discovery signal? — Resolved

**Decision: Option A — observe the conversation owner node status.** It reuses the persisted lifecycle state, survives a missed transition through snapshot reload, and adds no wire event. Web treats `running` as an idempotent attachment trigger and confirms current activity through the Agent stream endpoint.

Rejected Option B added a Canvas Sync `thread_run` event whose reliability would require active-run snapshot support and would overlap with Agent SSE. Rejected Option C kept an Agent SSE subscription open between turns and required a new idle cross-turn subscription protocol.

### OQ2 — Should history refresh happen before every externally discovered live attachment? — Resolved

**Decision: Option A — refresh history first.** It obtains the external user prompt without expanding `AgentStreamEvent`, then trims the partial assistant/status suffix before applying Tier-1 replay. The extra request is accepted to keep the transcript complete and preserve the existing shared event protocol.

Rejected Option B added a user or turn-start event to Agent SSE and expanded the shared wire protocol, folding, history projection, and every consumer. Rejected Option C showed tool/text progress without its initiating prompt and produced a temporarily inverted transcript.

### OQ3 — What is the resume identity for reconnect and deduplication? — Resolved

**Decision: Option A — replay from the current Tier-2 fence.** Every attachment removes the current incomplete turn's assistant/status projection and rebuilds it from the complete Tier-1 suffix under one fresh assistant message ID. This reuses `agenetes.tail` and keeps Tier-1 sequence numbers private.

Rejected Option B exposed a Tier-1 sequence cursor to Web. It offered precise incremental resume but added a public cursor contract, client watermark ownership, cursor-expiry semantics, and Agenetes subtree changes. It can be reconsidered if long-turn replay measurements show unacceptable cost or UX disruption.

### OQ4 — Which conversations should automatically attach? — Resolved

**Decision: Option A — only the actively visible conversation.** Background conversations invalidate history but do not consume an SSE connection or render unseen partial state. Opening a background thread loads durable history and attaches if its conversation owner remains `running`.

Rejected Option B attached every cached thread and introduced unbounded connection, partial-state, and cleanup ownership. Rejected Option C required a new pinned/background-tracking product concept outside issue #75.

### OQ5 — Should an Agent SSE transport failure automatically retry while the node remains `running`? — Resolved

**Decision: Option A — automatically reattach while `running`, reusing the existing page-refresh recovery flow.** After bounded backoff, the coordinator refreshes history, clears the incomplete assistant/status projection, and calls the existing `/api/agent/stream/:threadId` route backed by `agenetes.tail()`. Retry stops on terminal node state, explicit close/switch, intentional abort, or a confirmed inactive response.

Rejected Option B waited for another Canvas lifecycle change and could leave a long-running turn invisible after one transient stream failure.

### OQ6 — When is `historyLoadedThreads` considered valid after a live external turn? — Resolved

**Decision: Option A — keep history valid after a complete live terminal.** Background turns, missing terminal events, unrecoverable stream failures, or inactive responses without a complete local projection invalidate the thread. This avoids an unnecessary terminal request and preserves live message IDs and UI state on the healthy path.

Rejected Option B always invalidated and refetched at terminal, adding a request and risking message-ID replacement, UI-state loss, and a race with Tier-2 folding on every healthy turn.

### OQ7 — Should the active registry be process-local only? — Resolved

**Decision: Option A — process-local registry plus durable history fallback.** This matches the current desktop topology and keeps active execution ownership beside the existing turn lease and abort controller. After restart, incomplete Tier-1 records remain recoverable history but are not treated as live execution.

Rejected Option B derived activity from Agenetes Tier-1 state, where an incomplete-after-crash turn is indistinguishable from live execution without adding durable leases, process identity, heartbeats, and expiry semantics.

Cloud or multi-process fan-out remains outside this proposal.

## Open questions

No open questions remain for the initial implementation. Reconsider Tier-1 sequence cursors or multi-process active leases only if measured replay cost or deployment topology changes invalidate the current decisions.

## Code entry points

| File/dir                                                                                                               | Responsibility                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`apps/server/src/modules/agent/agent-thread.service.ts`](../../apps/server/src/modules/agent/agent-thread.service.ts) | Shared invocation lease, abort, active registry, dispatch, and settlement    |
| [`apps/server/src/modules/agent/agent.route.ts`](../../apps/server/src/modules/agent/agent.route.ts)                   | UI POST stream, history, stop, and live tail route                           |
| [`apps/server/src/modules/agent/agent-node-lifecycle.ts`](../../apps/server/src/modules/agent/agent-node-lifecycle.ts) | Fixed Agent Node `running` / `done` / `error` persistence                    |
| [`apps/server/src/modules/remote_fs/rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts)               | RFS Agent creation/prompt response stream                                    |
| [`external/agenetes/packages/agenetes/src/instance.ts`](../../external/agenetes/packages/agenetes/src/instance.ts)     | Tier-1 logging and subscribe-before-backfill `tail` fan-out                  |
| [`apps/web/src/api/agent.ts`](../../apps/web/src/api/agent.ts)                                                         | Agent SSE client and structured attachment outcomes                          |
| [`apps/web/src/hooks/useAgentStream.ts`](../../apps/web/src/hooks/useAgentStream.ts)                                   | Shared incremental `AgentStreamEvent` reducer                                |
| [`apps/web/src/hooks/useChatHistory.ts`](../../apps/web/src/hooks/useChatHistory.ts)                                   | Initial history loading and conversation-owner observation                   |
| [`apps/web/src/store/chatStore.ts`](../../apps/web/src/store/chatStore.ts)                                             | Per-thread messages, loading projection, and history validity                |
| [`apps/web/src/store/canvasSyncStore.ts`](../../apps/web/src/store/canvasSyncStore.ts)                                 | Canvas lifecycle delivery, heartbeat, reconnect, and snapshot reconciliation |
