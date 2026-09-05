# External Agent Capability Cache and Canonical Realization

Status: Accepted
Last updated: 2026-09-05

## Context

Issue [#160](https://github.com/microsoft/Huabu/issues/160) adds Space Prompt Frames whose content is frozen into a fixed Agent Node's durable WorkloadSpec when that Agent is first realized.

Issue [#162](https://github.com/microsoft/Huabu/issues/162) removes UI-triggered ACP warm sessions and replaces them with GET-only Profile/Harness capability discovery.

These changes share one lifecycle problem. Huabu currently starts an ACP session before the first user message so slash commands and selector metadata are available. A pre-message mode, model, or config-option change then obtains an Agenetes handle by calling `agenetes.create()` with a transport-minimal WorkloadSpec. Because Agenetes correctly treats a persisted Deployment spec as immutable and authoritative, that minimal spec can prevent the later message path from persisting the canonical fixed-node binding, launch overrides, node-specific instructions, and Space Prompt.

The root problem is not Prompt Frame discovery and not ACP session creation itself. The system currently lets metadata discovery, live-session creation, mutable control state, and immutable workload realization overlap without one explicit ownership boundary.

## Decision

Huabu will separate capability discovery, workload realization, and live ACP session state.

1. The Web reads last-observed external-agent capabilities from a GET-only Profile/Harness cache and never starts an ACP session merely to populate slash commands or selectors.
2. The first explicit Agent interaction realizes one complete canonical WorkloadSpec. An explicit interaction is either user input or a mode, model, or config-option control.
3. Control and message routes call the same server-owned realization pipeline and differ only after they receive the realized handle: control calls `handle.control()`, while a message calls `handle.run()`.
4. Fixed Agent Node identity is resolved from canonical Canvas state on the server. Client-supplied Profile or working-directory fields cannot override a fixed binding or its launch overrides.
5. ACP initial preamble remains pending after control-only realization and is delivered once by the driver on the first ordinary prompt.
6. WorkloadSpec is complete and immutable from its first durable write; mutable mode, model, config, session, and metadata state remains in the driver snapshot.
7. No compatibility migration or repair is required for bootstrap-only records created on the unshipped development branch.

## Goals

- Make opening an Agent Node, reading metadata, and opening slash-command UI side-effect free with respect to ACP process creation and durable workload creation.
- Preserve immediate UI rendering from cached commands and selector catalogues when prior observations exist.
- Allow a cold cache to degrade to empty/default UI without blocking the first user message.
- Ensure a first control and a first user message produce the same canonical WorkloadSpec.
- Snapshot the Space Prompt at the first explicit interaction for fixed Agent Nodes.
- Keep the existing Agenetes persisted-spec-authoritative invariant.
- Reconcile cached UI state with live agent reports after a real session starts.
- Keep permission-expanding selections safe when only stale or cross-thread observations exist.

## Non-goals

- Migrating or repairing bootstrap-only records created before this proposal ships.
- Guaranteeing that every harness publishes metadata before the first assistant response completes.
- Treating cached Profile/Harness observations as authoritative thread selections.
- Standardizing every harness on identical commands, models, modes, or config options.
- Changing Chat-V2 so control operations or initial preambles become conversation turns.
- Starting background capability-discovery processes solely to keep caches fresh.

## Terminology and ownership

| Concept                        | Owner                                    | Lifetime                       | Durable                      |
| ------------------------------ | ---------------------------------------- | ------------------------------ | ---------------------------- |
| Profile                        | Huabu Profile registry                   | User-managed                   | Yes                          |
| Harness capability observation | Profile/Harness capability cache         | Until refreshed or invalidated | Yes                          |
| Canonical WorkloadSpec         | Agenetes ThreadStore                     | Thread lifetime                | Yes                          |
| Driver selection and metadata  | AgentStateSnapshot                       | Thread lifetime                | Yes                          |
| ACP process/session            | ACP driver session registry and Agentlet | Live runtime                   | Native session identity only |
| Chat conversation              | Agenetes Tier-1/Tier-2 stores            | Thread lifetime                | Yes                          |

A Profile is a launch configuration associated with a harness. Commands and selector catalogues are usually harness capabilities, but their exact values may also depend on harness version, account entitlement, placement, launch configuration, or workspace. The first implementation keeps observations Profile-associated because that is the narrowest existing identity that safely contains those differences. A later optimization may deduplicate catalogue data by a stronger harness capability key.

## Capability cache

### Cached data

The cache stores the latest observed capability catalogue for a Profile:

```typescript
interface ExternalAgentCapabilityObservation {
  profileId: string;
  commands: AvailableCommand[];
  availableModes: SessionMode[];
  availableModels: SessionModel[];
  configOptions: SessionConfigOption[];
  lastObservedValues: {
    modeId?: string;
    modelId?: string;
    options?: Record<string, string | boolean>;
  };
  observedAt: number;
}
```

The concrete contract should reuse existing shared ACP metadata types rather than introduce parallel command or selector shapes.

`lastObservedValues` describes what a prior real session reported. It is not a confirmed value for a new thread and does not become durable thread intent merely because the UI displayed it.

### UI read path

Opening an Agent Node performs a GET-only cache read:

```text
Agent Node opens
  -> resolve Profile identity
  -> GET cached Profile capabilities
  -> render catalogue and last-observed values
  -> do not spawn an agent
  -> do not create a WorkloadSpec
```

A cache miss returns a successful empty observation or an explicit `source: none` result. The UI may hide unavailable selectors, show neutral defaults, and leave slash commands empty. Chat remains usable.

The Web no longer calls an ensure-session endpoint on cache miss, slash-menu open, metadata refresh, or ordinary panel mount.

### Cache refresh

When a real ACP session publishes commands, modes, models, or config options, Huabu updates both the active thread UI and the Profile capability cache.

The cache is observational and last-write-wins. A removed model, mode, command, or option disappears when a newer complete catalogue supersedes it. Partial agent updates retain the existing merge semantics required by the ACP protocol.

Permission-expanding values such as full access or auto-approve must not be presented as active for a new thread solely because they were last observed on another thread. They become active UI state only after the current session reports them or the current thread records a successful explicit selection.

## Canonical workload realization

### Trigger

The first explicit Agent interaction triggers realization:

- sending user input
- setting mode
- setting model
- setting a config option

The following do not trigger realization:

- opening an Agent Node
- reading capability cache
- opening slash-command UI
- reading commands or metadata
- restoring cached UI state

### Realization output

Realization creates one complete immutable WorkloadSpec containing:

- thread identity, namespace, driver kind, and workload type
- authoritative Agent binding
- Profile recipe and explicit Agentlet placement
- reachback environment
- effective working directory
- mandatory Huabu bootstrap
- frozen Space Prompt for a fixed Agent Node
- node-specific additional initial instructions
- complete launch overrides
- a versioned Huabu realization marker

The marker distinguishes a canonical workload from any future preparatory record without inspecting conversation logs or preamble contents.

### Fixed and non-fixed threads

For a fixed Agent Node, the server resolves the node by `(canvasId, threadId)` and treats its binding and launch overrides as authoritative. Client-supplied Profile and working-directory values are consistency hints only. A mismatch returns an explicit conflict response and does not create a workload.

For a non-fixed external thread, the server uses the schema-validated requested binding and supported request configuration. It does not collect or inject a Space Prompt.

### Shared entry point

Control and message routes use one realization service:

```typescript
const realized = await realizeExternalAgentThread({
  canvasId,
  threadId,
  requestedBinding,
});

if (interaction.type === 'control') {
  return realized.handle.control(interaction.control);
}

return realized.handle.run(interaction.submission, interaction.context);
```

The service reads an existing canonical record when present. Otherwise it resolves the target, collects the Prompt when eligible, builds the complete spec through the canonical ACP builder, persists it through Agenetes, and returns the realized handle.

No control route may construct a reduced WorkloadSpec.

## Realization and session boundaries

The workload and ACP session have independent lifecycles:

```text
Workload: unrealized -- first control/message --> realized and immutable
Session:  absent ----- first control/message --> live <--> suspended/resumed
```

Removing UI-triggered warm sessions means a normal new thread has no ACP process before its first explicit interaction. The realization pipeline creates the canonical workload before the driver creates or resumes the real session.

A control-only first interaction realizes the workload and creates the session but does not write a Chat-V2 turn and does not consume `initialPreamble`. The ACP driver delivers the ordered preamble once when the first ordinary prompt is lowered to `session/prompt`.

Session suspension, resume, process restart, and native session recovery reuse the immutable WorkloadSpec and never recollect the Space Prompt.

## Concurrency and failure

Realization uses a short-lived gate keyed by Canvas namespace and thread ID.

```text
first control ----\
                   -> realization gate -> one canonical WorkloadSpec
first message ----/
```

The gate covers target resolution, Prompt collection, spec construction, and durable creation. It is released before a long-running control or message operation.

The existing turn lease continues to protect message execution and is not replaced by the realization gate.

If realization fails before durable creation, no partial spec is written and a later explicit interaction may retry. If realization succeeds but a subsequent control is rejected, the finalized workload remains valid; workload identity and a mutable control result are separate concerns.

## Selection semantics

The UI resolves displayed values in this order:

```text
current thread's confirmed explicit selection
  > current live session report
  > Profile cache last-observed value
  > neutral harness/default presentation
```

Selecting a value before the first message is an explicit interaction. Huabu realizes the workload, creates the real session, validates the requested value against the live capability surface, sends the control, and records it only on success.

Agents such as Copilot CLI may persist model selection themselves. Huabu does not assume a particular harness persistence scope. It displays the cached observation initially, then reconciles to what the new real session reports.

## HTTP surface

The final surface separates safe reads from side-effecting interactions:

| Operation                           | Method semantics | Side effects                            |
| ----------------------------------- | ---------------- | --------------------------------------- |
| Read Profile capability observation | GET              | None                                    |
| Read realized thread metadata       | GET              | None                                    |
| Send mode/model/config control      | POST             | May realize workload and create session |
| Send user input                     | POST/SSE         | May realize workload and create session |

The UI-triggered ensure-session endpoint is removed from normal product flow and may be deleted when no internal caller requires it. A GET endpoint must never spawn or resume an Agent.

Every new or changed HTTP contract is defined once in `packages/shared/src/types/api`, validated with `safeParse` on the server, and imported type-only by the Web.

## Implementation sequence

Issue #162 is the implementation prerequisite for the #160 correction, but both ship in PR [#161](https://github.com/microsoft/Huabu/pull/161).

### Phase 1: Cache-only capability UI

- Expose one GET-only Profile capability observation contract.
- Reuse the existing Profile schema cache as the initial storage boundary.
- Make slash commands and session selectors read cached Profile observations without calling `ensureAcpSession`.
- Preserve cold-cache empty/default UI and live event reconciliation.
- Remove normal Web dependencies on `POST /threads/:threadId/session`.

### Phase 2: Canonical realization service

- Extract the shared external-thread realization pipeline.
- Resolve fixed targets from server-side Canvas state.
- Collect Space Prompt and apply launch overrides exactly once.
- Add a versioned realization marker to the canonical ACP host context.
- Add a namespace-and-thread realization gate.

### Phase 3: Unify interactions

- Route first and subsequent user messages through the realization service.
- Route mode, model, and config-option controls through the same service.
- Remove reduced WorkloadSpec construction from ACP control routes.
- Keep control operations outside Chat-V2 and preserve one-shot initial preamble delivery.

### Phase 4: Remove obsolete warm-session flow

- Delete unused Web API wrappers, polling, connection states, and ensure-session route code.
- Keep ACP driver session creation as an internal consequence of real control or run operations.
- Update architecture documentation to describe the shipped cache and realization boundaries.

## Regression coverage

- Opening an Agent Node, reading capability cache, and opening slash-command UI do not start an ACP session or create a ThreadRecord.
- A cold cache does not block the first user message.
- Cached commands and selectors render before a session exists.
- Live metadata reconciles the UI and refreshes the Profile cache.
- A first fixed-node control persists the same canonical spec as a first fixed-node message.
- Space Prompt and node-specific instructions are present after first-control realization.
- A first control does not write a Chat-V2 turn or consume the initial preamble.
- The first ordinary prompt delivers the preamble once.
- Subsequent controls mutate driver state without changing the WorkloadSpec.
- Concurrent first control and message requests create one canonical workload.
- Fixed binding mismatch is rejected without persisting a workload.
- Non-fixed external threads realize without a Space Prompt.
- Permission-expanding cached observations are not presented as confirmed current-thread state.

## Code entry points

| File/dir                                                                                                                       | Responsibility                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| [`apps/server/src/modules/agent/agent-thread.service.ts`](../../apps/server/src/modules/agent/agent-thread.service.ts)         | Current message-side fixed-target and Space Prompt orchestration; source for the shared realization boundary.               |
| [`apps/server/src/modules/agent/agent-thread-resolver.ts`](../../apps/server/src/modules/agent/agent-thread-resolver.ts)       | Canonical fixed Agent Node lookup and launch-override validation.                                                           |
| [`apps/server/src/modules/agent/acp/service.ts`](../../apps/server/src/modules/agent/acp/service.ts)                           | Canonical ACP WorkloadSpec builder and message execution.                                                                   |
| [`apps/server/src/modules/agent/acp/threads.route.ts`](../../apps/server/src/modules/agent/acp/threads.route.ts)               | Current session metadata and control routes; reduced spec creation and warm-session endpoints are removed from normal flow. |
| [`apps/server/src/modules/agent/acp/profile-schema-cache.ts`](../../apps/server/src/modules/agent/acp/profile-schema-cache.ts) | Existing Profile-associated capability observation cache.                                                                   |
| [`apps/server/src/modules/agent/space-instruction-frames.ts`](../../apps/server/src/modules/agent/space-instruction-frames.ts) | Deterministic Space Prompt collection used during fixed-node realization.                                                   |
| [`apps/web/src/hooks/useAcpSessionMeta.ts`](../../apps/web/src/hooks/useAcpSessionMeta.ts)                                     | Selector catalogue cache read and live-session reconciliation.                                                              |
| [`apps/web/src/hooks/useAcpSlashCommands.ts`](../../apps/web/src/hooks/useAcpSlashCommands.ts)                                 | Slash-command cache read without session creation.                                                                          |
| [`external/agenetes/packages/acp-driver/src/handle.ts`](../../external/agenetes/packages/acp-driver/src/handle.ts)             | ACP session creation, control/run behavior, and one-shot preamble delivery.                                                 |
| [`external/agenetes/packages/agenetes/src/instance.ts`](../../external/agenetes/packages/agenetes/src/instance.ts)             | Immutable persisted-spec and live-handle lifecycle.                                                                         |
