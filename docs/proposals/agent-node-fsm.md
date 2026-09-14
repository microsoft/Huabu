# Server-Owned Agent Node State Machine

Status: Proposed
Last updated: 2026-09-14
Issue: [#163](https://github.com/microsoft/Huabu/issues/163)

## Context and scope

Huabu currently uses `agentBindingPolicy` both for pre-message Profile selection and as a proxy for lifecycle ownership: fixed Agent Nodes receive server-authored lifecycle updates, while selectable Question Nodes retain browser-authored updates. Binding mutability should not decide who owns execution state.

This proposal defines one Huabu Server-owned Agent Node FSM, with two separate dimensions: **execution binding** and **prompt invocation**. It targets a small personal-use application with one Huabu Server, not a distributed orchestration system. It is a proposed contract, not a description of shipped behavior or authorization to implement it.

Reuse `AgentThreadService`, canonical realization, `AgentNodeLifecycle`, and existing Canvas persistence and synchronization. Do not introduce another Agent runtime, FSM library, event journal, or automatic recovery subsystem.

## Terminology and ownership

| Concept                     | Meaning                                                                                                       | Authority                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Execution-preparation draft | Selected Profile and explicit launch overrides saved before execution binding is established                  | Huabu Canvas Node                                                         |
| Execution binding           | Monotonic Editing-to-Bound business state persisted on the node after confirming a canonical execution record | Huabu owns the node state; Agenetes ThreadStore supplies the binding fact |
| Prompt invocation           | One admitted prompt, from preparation through settlement                                                      | Huabu `AgentThreadService`                                                |
| Execution facts             | Workload realization, run events/results, control acknowledgements and existing history                       | Agenetes, interpreted by Huabu                                            |
| Browser-local state         | Unsent input, pending edits, saving, request progress and connection indicators                               | Browser                                                                   |
| Result attention            | Whether the user has viewed the current terminal result                                                       | User acknowledgement, validated by Huabu                                  |

A node may already have a `threadId` without an execution binding. Conversely, an established binding does not mean a process is resident or a prompt is running. Avoid the term "configuration identity": configuration is data; execution binding is the relationship established from it.

## 1. Execution-binding FSM

```mermaid
stateDiagram-v2
    direction LR
    state "Editing: execution-preparation draft" as Editing
    state "Bound: confirmed execution binding" as Bound

    [*] --> Editing: Create a new thread-backed node
    Editing --> Editing: Save draft after confirming no existing binding
    Editing --> Editing: Open panel or read capabilities
    Editing --> Editing: Preparation fails before commitment
    Editing --> Bound: Confirm persisted ThreadRecord / save bindingState
    Bound --> Bound: Later prompt or supported control
    Bound --> Bound: Prompt completes, fails, or stops
    Bound --> Bound: Runtime session closes
```

This diagram describes a new node. A persisted Bound node stays Bound when loaded; it does not recreate a draft. An Editing or legacy node may already have a canonical execution record and must confirm that fact before accepting a configuration change or first interaction. Missing records with existing execution history are inconsistent evidence, not permission to silently bind a different Agent.

The source of truth for establishing Bound is a validated, persisted Agenetes ThreadRecord for the node's namespace and thread. Huabu records that confirmed fact as `bindingState: bound` on the node. Neither sending a browser request, allocating a thread ID, receiving the first token, nor obtaining a native Session ID is the binding criterion. If realization succeeds but session startup or control later fails, the binding remains established.

There is no Bound-to-Editing transition for the same execution binding. Supported runtime settings may still change through existing controls; this does not mean every setting is frozen. Internal thread-associated Jobs retain their existing execution strategy and do not become a separate Agent Node type. Do not assume every workload is an immutable Deployment.

### Binding authority, query and persistence

Use the existing public Agenetes interface:

```typescript
agenetes.record(namespace, threadId): ThreadRecord | undefined
```

This is an in-process library call, not an HTTP/ACP request to the Agent. It delegates to `threadStore.get(namespace, threadId)` and validates an existing record before returning it. It is independent of a live handle and does not create a session or send a prompt/control. The existing external realization path already uses this interface.

The binding coordinator confirms that the returned record belongs to the intended thread/namespace and carries a supported canonical execution identity. Record presence must not bypass existing driver/binding validation. A native Session ID is neither persisted into the node for this purpose nor exposed as its state criterion.

| Data                                                                 | Persistence on the current Disk backend                | Role                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `bindingState: editing \| bound` (proposed)                          | `space.json`, in the corresponding node's `data`       | Huabu's durable, monotonic acknowledgement of binding                         |
| `threadId`, selected `agentBinding`, explicit `agentLaunchOverrides` | `space.json`, in node `data`                           | Node association and execution-preparation configuration                      |
| Canonical ThreadRecord / WorkloadSpec                                | `.history/threads.json`, owned by Agenetes ThreadStore | Source of truth for confirming binding and for actual execution configuration |
| Node text and content metadata                                       | `nodes/<label>.md` body and frontmatter                | Authored content, not binding-state persistence                               |

There is one `space.json` per Space, not one `canvas.json` per Agent Node. Application modules use existing Canvas/storage and Agenetes interfaces rather than reading or editing these files directly.

`bindingState` is separate from the prompt result's `status`. Bound is a persisted acknowledgement of an established fact, not a second editable copy of WorkloadSpec and not a continuously refreshed runtime-presence cache. Ordinary editability checks use the node's state; they do not query Agenetes again for a Bound node. Runtime dispatch still uses Agenetes execution records normally.

| Boundary                                                                          | Query and write behavior                                                                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Load or display an already Bound node                                             | Read node metadata; no additional ThreadStore lookup solely to determine editability                  |
| Accept a draft configuration edit or first interaction for an Editing/legacy node | Query the canonical record through the binding coordinator; reuse the result within this operation    |
| Existing valid record found                                                       | Persist Bound and use canonical execution identity; reject a requested incompatible draft edit        |
| No record and no conflicting execution evidence                                   | Allow draft editing, or realize on actual interaction; confirm the resulting record and persist Bound |
| Token event, browser render or layout operation                                   | No binding-state lookup or transition                                                                 |

An absent legacy field is unconfirmed, not proof of a genuinely fresh thread. Existing records are recognized lazily at the relevant operation boundary; no whole-Space migration scan or polling loop is required.

### Ordering and the small partial-write case

The ordering is canonical ThreadRecord persistence, confirmation through the existing record interface, then the Canvas write of Bound. A failed Bound write must be surfaced and must not be treated as a successful transition by the caller. It cannot roll back the canonical binding.

If the record exists but the node still says Editing because the Canvas write failed or the process stopped, the next guarded edit/interaction recognizes the record and completes the one-way promotion before proceeding. Do this on an explicit operation path, not as an incidental GET side effect. This is bounded completion of one business transition, not an automatic turn-recovery system.

Keep draft-edit acceptance and first binding ordered through the same local coordination boundary so an edit cannot pass its check and overwrite preparation configuration while realization commits. Reuse existing process-local coordination and keep this critical section focused; no cross-store transaction or distributed lock is proposed.

Once Bound is persisted, a missing or invalid ThreadRecord produces an explicit execution-record error; it never resets the node to Editing. Ordinary Canvas saves and undo cannot demote Bound or modify the established execution-preparation configuration. Supported runtime controls remain separate. This supersedes the earlier decision to defer all post-binding configuration-write restrictions, but does not imply a general authored-content or Canvas write firewall.

## 2. Prompt-invocation FSM

```mermaid
stateDiagram-v2
    direction LR
    state "Idle: no admitted prompt yet" as Idle
    state "Preparing" as Preparing
    state "Executing" as Executing
    state "Stopping: cancellation requested" as Stopping
    state "Settled" as Settled

    [*] --> Idle
    Idle --> Preparing: Admit prompt
    Settled --> Preparing: Admit next prompt
    Preparing --> Executing: Ready and not cancelled / dispatch
    Preparing --> Settled: Preparation fails
    Preparing --> Stopping: Request stop
    Executing --> Stopping: Request stop
    Executing --> Settled: Execution completes or fails
    Stopping --> Settled: Preparation unwinds or execution settles
```

Settled carries an outcome; it is not the end of the thread. The next prompt uses the same execution binding and a new invocation identity.

Rejected requests do not create transitions. Admission must not replace an unsettled invocation. Preserve the existing admission mechanism, including any waiting behavior; waiting for admission is not an admitted prompt. Install cancellation tracking before slow preparation, and do not dispatch after cancellation has intervened.

A stop acknowledgement means cancellation was requested, not that execution ended. Retain admission until actual settlement. A late stop does not rewrite an already established completion or failure as cancellation.

### How the two diagrams relate

| Operation                           | Execution binding                                           | Prompt invocation                          |
| ----------------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| Save valid draft / open panel       | Editing stays Editing; opening a Bound node leaves it Bound | No change                                  |
| First prompt                        | May become Bound during preparation                         | Preparing -> Executing -> Settled          |
| First external control              | May become Bound                                            | No change; no prompt is invented           |
| Control fails after commitment      | Remains Bound                                               | No change to the previous prompt's outcome |
| Preparation fails before commitment | Remains Editing                                             | Settled with failure                       |
| Preparation fails after commitment  | Remains Bound                                               | Settled with failure                       |
| Follow-up prompt                    | Remains Bound                                               | New invocation                             |

Controls retain their existing driver semantics; the diagrams do not impose blanket mutual exclusion between all controls and prompts. First-interaction realization must still use the existing canonical coordination rather than creating competing execution identities.

## 3. Persisted projection, not a second runtime

Keep the existing Canvas status vocabulary:

| Server invocation state/outcome  | Node `status`                                |
| -------------------------------- | -------------------------------------------- |
| No admitted prompt               | `idle` or absent                             |
| Preparing / Executing / Stopping | `running`                                    |
| Normal completion                | `done`                                       |
| Confirmed cancellation           | `done`, preserving current node presentation |
| Preparation or execution failure | `error`                                      |

The live phase, cancellation controller and settlement guard stay in the existing server invocation object. Agenetes does not expose a universal Agent Node lifecycle enum: Huabu maps supported execution facts, not opaque driver state.

Propose one server-authored current-invocation token on the node. Replace it at admission and retain it with the result. Check it at the serialized write boundary to prevent an old completion from modifying a newer invocation, and use it to validate viewed acknowledgements. It is not a durable Agenetes turn identifier or a restart-recovery log; exact field/API names remain an implementation detail.

Persist `status`, `errorMessage`, the token and result attention through the existing Canvas writer, alongside the separate monotonic `bindingState`. Ordinary browser structure saves and inverse operations must preserve server-owned lifecycle metadata rather than restore stale snapshots or demote Bound. Enforce the binding-specific configuration rule above without redesigning general Canvas or authored-content editing.

## 4. Commands and effects

| Command or fact            | Required effect                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Draft edit                 | Save through existing Canvas editing; no workload or session creation                                         |
| First interaction          | Use the intended acknowledged saved configuration; do not substitute stale ChatStore values                   |
| Accepted prompt            | Publish the new token and running state before dispatch; a failed initial projection prevents dispatch        |
| First accepted user prompt | Fill an empty, never-submitted node's content using fresh state; preserve existing authored content           |
| Terminal result            | Publish the matching outcome and unread attention, then release admission with guaranteed cleanup             |
| View result                | Mark only the observed current terminal token viewed                                                          |
| Projection-write failure   | Surface/log projection failure separately from the Agent outcome; release resources without inventing success |

The first-content rule records submitted intent, not proof of model execution. Preparation failure or cancellation does not erase that text. Controls and follow-ups do not replace it. Never use a stale `status === idle` snapshot as proof that this is the first prompt.

The browser owns pending edits and request feedback, but not authoritative node running/done/error writes or history-based repair. A save queue finishing is not necessarily acknowledgement that the intended draft was saved. Fail explicitly on a conflicting selection instead of silently dispatching a different Agent.

Valid empty output is not an execution failure, and a handled tool error is not automatically a failed prompt. Existing Done/error/abort event precedence needs targeted characterization before changing adapter behavior; the ownership refactor must not silently redefine driver outcomes.

## 5. Refresh and restart boundaries

Browser refresh observes the running server and its persisted projection. Disconnection alone is not execution settlement; preserve any route's existing explicit cancellation contract.

After server restart, a persisted running node with no matching live tracking is **untracked**, not proven successful, failed, or stopped. Expose that discrepancy through server observation and existing UI feedback without a read-triggered Canvas repair, an old-history guess, or automatic replay.

For an untracked attempt, use existing supported runtime admission/status behavior if it can establish that a follow-up is safe. Otherwise report that the previous execution cannot be confirmed instead of starting a duplicate prompt. A surviving external process is not assumed dead just because Huabu's memory was lost.

Automatic reattachment, guaranteed crash recovery, durable invocation-to-turn correlation, background repair sweeps and a new recovery workflow are not prerequisites. If a concrete driver leaves ordinary personal use stuck, resolve that specific UX problem separately rather than building speculative infrastructure.

## 6. Implementation boundary and open details

| Area                   | Focused change                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server coordinator     | Use one lifecycle owner for node-backed Web/direct RFS prompts regardless of policy; include cancellable preparation in the admitted lifetime                                         |
| Resolver / realization | Reuse generic node identity resolution and existing validation; confirm ThreadRecord through `agenetes.record`, persist Bound once, and use canonical execution identity for dispatch |
| Canvas projection      | Extend the existing lifecycle writer with current-invocation guards and narrowly protected fields                                                                                     |
| Browser                | Persist draft selection through existing APIs; remove policy-dependent lifecycle/rescue writes on migrated paths                                                                      |
| Contracts / docs       | Define changed HTTP/SSE fields in shared schemas and update architecture with eventual implementation                                                                                 |

Task/Run/Interactive View redesign and owner-eligibility changes remain excluded. Preserve their caller contracts where they share services; bring any necessary semantic change back for an explicit scope decision. Node-less chat behavior is not converted into an Agent Node FSM.

Global deletion of `agentBindingPolicy`, Profile lock indicators, new FSM dependencies, distributed locks, cross-store transactions and general autosave/undo redesign are not required.

The binding coordinator belongs to Huabu Server's Agent Node business layer under `modules/agent/`; its exact name is not decided. It owns binding reads, guarded draft edits and first-binding orchestration through existing resolver/realization/Canvas interfaces. `AgentThreadService` owns each live prompt invocation and calls this coordinator during preparation; the external control path uses the same binding entry without creating a prompt invocation. `AgentNodeLifecycle` remains a projection writer, not a third independent state machine. No event bus or bidirectional FSM synchronization is needed.

Before implementation approval, settle the binding-state and invocation-token wire schemas, concrete field-preservation/ordering points, first-submission detection for legacy empty nodes, driver terminal-event compatibility, and compatibility wiring for excluded callers. This proposal does not claim those integration details are implemented.

## 7. Acceptance scenarios

- Absent/selectable/fixed policy does not change lifecycle ownership on migrated paths.
- Creating/configuring/opening a node does not realize an Agent; first actual control can bind without creating a prompt.
- First and follow-up prompts use the same server transitions and canonical execution binding.
- Failed draft saving does not silently dispatch stale configuration.
- Preparation failure/cancellation cannot dispatch a delayed prompt or erase an established binding.
- Stop acknowledgement alone does not release admission.
- Old completion, browser snapshots and viewed acknowledgements cannot overwrite a newer invocation/result.
- Refresh observes server state; restart uncertainty does not fabricate a result or trigger replay.
- Existing Job behavior and excluded callers retain their contracts.
- A validated ThreadRecord promotes Editing/legacy state to persisted Bound; subsequent editability checks on Bound do not query Agenetes.
- A failure between ThreadRecord persistence and the Bound write cannot permit rebinding; the next guarded operation completes promotion.
- Missing records, session closure, old snapshots and undo never demote a Bound node to Editing.

## Code and design references

| Reference                                                                                     | Responsibility                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [AgentThreadService](../../apps/server/src/modules/agent/agent-thread.service.ts)             | Admission, cancellation, dispatch and settlement       |
| [AgentNodeLifecycle](../../apps/server/src/modules/agent/agent-node-lifecycle.ts)             | Existing server projection writer                      |
| [AgentThreadResolver](../../apps/server/src/modules/agent/agent-thread-resolver.ts)           | Generic and fixed-target resolution                    |
| [External realization](../../apps/server/src/modules/agent/acp/external-agent-realization.ts) | Canonical first-interaction realization                |
| [Question Node architecture](../architecture/question-node.md)                                | Current persisted fields and split lifecycle ownership |
| [Agent architecture](../architecture/agent-architecture.md)                                   | Existing runtime and transport                         |
| [API design](../architecture/api-design.md)                                                   | Shared wire-contract rules                             |
| [Canonical realization proposal](./external-agent-capability-cache-and-realization.md)        | Capability reads versus real interaction               |
