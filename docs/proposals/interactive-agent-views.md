# Interactive Agent Views

> Define a generic capability bridge through which an external Agent can create a sandboxed HTML view, exchange persistent structured state with a user, observe bounded Huabu data, and receive validated user actions in its existing Agent thread without adding Agent-specific UI code to Huabu.
>
> Status: **In Progress** · Last updated: 2026-08-10 · Tracks: [#431](https://github.com/hai-team/Sediment/issues/431) · Validated by: [#426](https://github.com/hai-team/Sediment/issues/426)

---

## 1. Context

Huabu already lets an external Agent upload an HTML artifact, create a Web Node, create durable Tasks and Runs through RFS, and create or continue visible Agent threads. These capabilities are sufficient for an Agent to produce content and orchestrate work, but not for the Agent to expose an interactive application-like surface inside the Canvas.

An HTML artifact currently runs as untrusted iframe content. It can render controls and maintain ephemeral browser state, but it has no safe contract for persisting user input, observing host-owned Task and Run data, navigating to Huabu resources, or sending a structured user event to the Agent thread that created it. Giving the iframe an RFS bearer credential, cookies, raw API routes, or ambient host access would turn uploaded HTML into a privileged plugin and violate the existing trust boundary.

The Issue Tracker Agent Team provides the motivating vertical slice. It needs one Anchor View with two user-configured filesystem paths, a table of tracked Tasks and Runs, links to their Agent Nodes and threads, and controls that send user decisions back to the coordinating external Agent. The Issue Tracker must remain an ordinary Agent Team package: once the generic platform capability ships, adding or changing that package must not require Issue Tracker-specific code in Huabu.

Issue [#431](https://github.com/hai-team/Sediment/issues/431) describes the broader need for constrained agent-authored UI. This proposal narrows that direction into a concrete external-Agent interaction contract while preserving a path toward a larger declarative view vocabulary.

## 2. Product promise

An external Agent can create a visible interactive view in the current Space and use that view as a durable user-interaction surface:

```text
external Agent package
  ├─ HTML/CSS/JS renderer artifact
  ├─ versioned View Definition
  ├─ initial structured state
  └─ bounded capability requests
                │
                ▼
       sandboxed Canvas view
                │ MessagePort
                ▼
      Huabu Interactive View Bridge
  ├─ persistent revisioned state
  ├─ host-owned data projections
  ├─ capability-bound user actions
  ├─ native resource navigation
  └─ submission to pre-bound Agent threads
```

Huabu understands views, state, bindings, capabilities, actions, and Agent-thread ownership. Huabu does not understand issue trackers, repository paths, worktree policy, issue status, or the business meaning of an Agent package's fields.

## 3. Goals

1. Let an external Agent create a sandboxed HTML-based Canvas view without embedding privileged application code.
2. Let users edit structured view state that survives iframe reload, node close/reopen, Space reload, and Huabu restart.
3. Let a view observe explicitly granted, bounded host data such as the current Space's Tasks and Runs without receiving API credentials.
4. Let a user action become a validated event delivered to one pre-bound Agent thread.
5. Let a view request native navigation to explicitly bound Huabu Nodes and threads.
6. Keep every capability closed, versioned, schema-validated, rate-limited, observable, and authorized by the host.
7. Ensure a new Agent Team can ship its own renderer and workflow without adding package-specific routes, components, data models, or action handlers to Huabu.
8. Preserve existing Web Node behavior for remote pages, static snapshots, reader views, and ordinary HTML artifacts.

## 4. Non-goals

- Turning arbitrary HTML into a general Huabu plugin runtime.
- Giving iframe content `AGENTLET_TOKEN`, cookies, raw RFS access, arbitrary HTTP access, filesystem access, Electron APIs, or host DOM access.
- Letting a view choose arbitrary Agent thread IDs, Node IDs, API routes, Canvas commands, or external destinations at action time.
- Encoding Issue Tracker, Git, worktree, Task orchestration, or approval semantics in the generic bridge.
- Replacing native Huabu UI for safety-critical permission prompts or destructive confirmations.
- Defining a complete cross-platform component system in the first version.
- Treating client-side button visibility, disabled state, or HTML validation as authorization.
- Making arbitrary remote Web Nodes interactive with Huabu capabilities.

## 5. Design principles

### 5.1 The renderer is untrusted

Agent-authored HTML, scripts, styles, data, event payloads, and action labels are untrusted input. The iframe may present the UI but never owns authorization, resource identity, persistence, or mutation.

### 5.2 Capabilities are bound before interaction

The Agent requests a fixed set of capabilities when creating or updating the View Definition. The host validates and persists the granted subset. Runtime iframe messages refer only to stable capability and action IDs; they cannot construct a new target.

### 5.3 State and data are separate

View state is durable Agent/user-owned JSON, such as Issue Tracker configuration. Bound data is a host-owned projection, such as the current Task Store. The renderer receives both, but cannot mutate host data by changing its local model.

### 5.4 Agent interaction reuses the existing thread

A view is not a second conversation system. A user event is submitted through the existing `AgentThreadService` path to a thread fixed in the View Definition, so turn leases, durable history, recovery, lifecycle updates, and external Profile execution remain canonical.

### 5.5 HTML is a renderer, not the protocol

The canonical artifact is a versioned View Definition plus persistent state and bindings. HTML/CSS/JS is one renderer kind. This separation allows a future declarative renderer without changing state, capability, action, or Agent-event semantics.

### 5.6 Agent-specific behavior remains in the Agent package

Huabu provides only generic primitives. The Issue Tracker package defines its field names, HTML layout, input validation hints, status labels, Agent instructions, and orchestration policy.

### 5.7 Single-user trusted-Agent identity

Huabu is currently a personal, single-user tool. Every external Agent that holds the valid `AGENTLET_TOKEN` is a trusted actor. The token protects the RFS transport boundary; it does not establish a distinct security principal for each Agent thread.

`HUABU_THREAD_ID`, `X-Huabu-Host-Thread-Id`, and persisted owner-thread fields provide correlation and routing, not authentication or authorization. The Server validates that a referenced owner is a durable external Agent thread in the current Canvas namespace, but it does not require an Agent Node or fixed Node binding policy, issue per-thread credentials, enforce Agent-to-Agent ACLs, or prevent one trusted Agent from naming another known thread.

The iframe remains untrusted. It cannot choose a thread at action time and may invoke only the owner thread persisted by a trusted Agent in the owning Node. The owner identity is fixed as `canvasId + ownerThreadId`; the current external binding is recovered from that thread's durable Agenetes workload record. Multi-user identity, untrusted Agents, thread-scoped credentials, and cross-Agent authorization are deferred until the product trust model requires them.

## 6. Vocabulary

| Term                 | Meaning                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Interactive View** | A local-HTML Web Node whose persisted data contains a valid Interactive View definition and state.                                                    |
| **View Node**        | The sole identity and persistence owner of one Interactive View. Its existing `nodeId` is also the View identity.                                     |
| **View Definition**  | The versioned, host-validated Node data describing renderer, state schema and value, data bindings, actions, and owner-thread routing.                |
| **View State**       | JSON persisted inside the owning Node and editable only through validated state actions using a derived View revision.                                |
| **Data Binding**     | A read-only host projection selected from a closed source registry and delivered to the view as replacement snapshots.                                |
| **Action Grant**     | A host-persisted permission inside the owning Node for one named action to target one fixed host operation or resource.                               |
| **View Intent**      | One validated request sent from the iframe to the host over the scoped bridge channel.                                                                |
| **View Event**       | The canonical durable submission delivered by the host to the owner Agent thread after an allowed user action.                                        |
| **Owner thread**     | The trusted Agent-selected thread persisted for event routing. It is validated for current-Canvas existence but is not a separate security principal. |
| **Anchor View**      | An Interactive View used by an Agent workflow as its durable configuration and status surface.                                                        |

## 7. Persisted model

### 7.1 One Node is one View

The local-HTML Web Node is the only persistent resource. It owns the renderer reference, protocol definition, state, bindings, action grants, and owner-thread routing:

```typescript
interface InteractiveWebViewData extends WebNodeData {
  viewKey?: string;
  interactiveView: {
    protocolVersion: 1;
    ownerThreadId: string;
    state: {
      schema: JsonSchemaSubset;
      value: JsonValue;
    };
    bindings: readonly ViewDataBindingV1[];
    actions: readonly ViewActionGrantV1[];
  };
}
```

The existing `nodeId` is the View identity; the protocol does not mint a second `viewId`. `src` remains the same-Canvas HTML artifact reference already owned by the Web Node. `viewKey` is an optional Agent-defined discovery hint such as `issue-tracker`; it is not authorization or global identity.

The renderer artifact must belong to the same Canvas. Replacing `src` updates the renderer without replacing `interactiveView.state`.

### 7.2 View State

View State lives under `data.interactiveView.state.value`. Writes replace the complete `state.value`, require the last observed `viewRevision = hash(definition)`, and go through the canonical Canvas executor. The host recomputes that deterministic revision inside the Canvas write mutex, so unrelated Canvas or Web authored-content changes do not create false conflicts. The host validates the complete replacement against the persisted state schema before writing it; a stale write returns the current revision and state and never silently overwrites newer definition or state.

The supported schema language is a deliberately bounded JSON Schema subset: object, array, string, number, boolean, null, required properties, enum, length/range limits, and closed object properties. It excludes executable expressions, remote references, custom JavaScript validators, and schema-driven network access.

State may contain user-entered paths because those values are the purpose of the Issue Tracker View, but Huabu never injects ambient filesystem paths or credentials. The View Definition must explicitly declare each state field, and the host enforces size limits and prohibits known secret fields.

### 7.3 Storage ownership

The owning Node and its normal Canvas persistence are the source of truth. Definition and State are not embedded in the HTML artifact, reconstructed from iframe local storage, or copied into a separate repository.

Deleting the Node immediately ends the View lifecycle: the host closes its MessagePort and every action and binding becomes invalid. Each action rechecks that the Node still exists and still carries the applicable definition. No tombstone, cascade, capability-revocation record, or cross-resource transaction is required.

Hiding, collapsing, closing, or switching away from the Node detaches runtime subscriptions without changing persisted data. If ordinary Canvas undo restores the complete Node while its artifact still exists, mounting it establishes a fresh bridge. A missing artifact produces an explicit unavailable state and no implicit repair.

Artifact deletion remains governed by the existing artifact ownership and future garbage-collection policy. Removing a View Node does not immediately delete an artifact that another Node may reference.

## 8. Renderer and sandbox

Interactive capability is available only to local HTML artifacts explicitly registered as Interactive Views. Existing remote URLs, reader views, snapshots, and ordinary HTML artifacts retain their current behavior and receive no bridge.

The iframe retains `allow-scripts` and `allow-forms` without `allow-same-origin`. Popups, top navigation, downloads, clipboard access, modals, pointer lock, device permissions, and external resource loading are denied by default. A dedicated renderer route applies a restrictive CSP: first-version Views are self-contained and may use inline script/style plus data/blob image, font, and media sources, while network connections, forms, nested frames, workers, objects, and external navigation are denied.

The host does not place bearer credentials, cookies, API URLs, Node IDs, thread IDs, or capabilities in query parameters, global variables, DOM attributes, or artifact contents.

The bridge uses a transferred `MessagePort` rather than an ambient `window.postMessage` request channel:

```text
iframe load
  → host verifies the mounted iframe instance
  → host transfers one MessagePort with protocol bootstrap
  → iframe and host exchange correlated messages on that port
  → unmount closes the port and subscriptions
```

The current reader-view resize `postMessage` remains separate and does not grant Interactive View capabilities.

## 9. Bridge protocol

### 9.1 Bootstrap

The host opens the channel with a snapshot:

```typescript
interface InteractiveViewBootstrapV1 {
  type: 'huabu.view.bootstrap';
  protocolVersion: 1;
  nodeId: string;
  revision: string;
  state: JsonValue;
  data: Record<string, ViewDataSnapshotV1>;
  actions: readonly {
    actionId: string;
    kind: ViewActionKindV1;
  }[];
}
```

The bootstrap reveals only capabilities and data already granted by the persisted definition.

### 9.2 Requests

Every iframe request carries a unique correlation ID:

```typescript
interface InteractiveViewIntentV1 {
  type: 'huabu.view.intent';
  protocolVersion: 1;
  nodeId: string;
  requestId: string;
  actionId: string;
  bindingRevision?: string;
  input?: JsonValue;
}
```

The host validates protocol version, mounted port ownership, view identity, action ID, action applicability, input schema, payload size, current resource binding, authorization, replay status, and rate limit before reaching an application service.

### 9.3 Outcomes

Every accepted request receives a terminal outcome, with optional pending progress:

```typescript
type InteractiveViewOutcomeV1 =
  | {
      type: 'huabu.view.outcome';
      requestId: string;
      status: 'pending';
    }
  | {
      type: 'huabu.view.outcome';
      requestId: string;
      status: 'success';
      result?: JsonValue;
    }
  | {
      type: 'huabu.view.outcome';
      requestId: string;
      status: 'error' | 'conflict' | 'unauthorized';
      code: string;
      message: string;
      currentRevision?: string;
    };
```

Unknown, stale, oversized, malformed, rate-limited, unauthorized, replayed, or no-longer-applicable requests fail explicitly.

## 10. Closed action vocabulary

The first version supports a small host-owned registry:

```typescript
type ViewActionKindV1 =
  | 'state.replace'
  | 'data.refresh'
  | 'agent.submit'
  | 'navigation.open-node'
  | 'navigation.open-thread';
```

### 10.1 State replacement

`state.replace` supplies the complete next View State value and the last observed View revision. The host validates the whole value against the persisted state schema and writes it using View-scoped compare-and-swap semantics. The first version does not define merge or JSON Patch behavior; callers resolve conflicts by loading the current value and submitting a new replacement.

```typescript
interface StateReplaceInputV1 {
  revision: string;
  value: JsonValue;
}
```

### 10.2 Data refresh

`data.refresh` asks the host to resolve one definition-bound data source again. The iframe cannot supply a source, query, Canvas ID, limit, or filter that was not granted.

### 10.3 Agent submission

`agent.submit` targets the single owner thread persisted in the Node by a trusted Agent. The iframe supplies only the action's validated input and cannot select or override a thread.

The host constructs a canonical event:

```typescript
interface InteractiveViewAgentEventV1 {
  protocolVersion: 1;
  nodeId: string;
  actionId: string;
  input?: JsonValue;
  nodeRevision: string;
}

type HuabuInteractiveViewSubmissionV1 = AgentSubmission<
  InteractiveViewAgentEventV1,
  'huabu.interactive-view'
>;

type HuabuSubmission = HuabuChatSubmission | HuabuInteractiveViewSubmissionV1;
```

The existing Agenetes `AgentSubmission<TSource, TType>` contract already supports an arbitrary structured source payload plus optional host-rendered canonical `AgentInput[]`. Huabu therefore adds `HuabuInteractiveViewSubmissionV1` as a second Huabu submission variant rather than introducing a new `AgentInput` variant. Its structured `content` remains the durable turn source, while its `rendered` field contains a deterministic existing `text` or `parts` input that labels iframe-authored values as user event data rather than host instructions.

The current Huabu adapter accepts only `content: string` plus `ChatEnvelope` and constructs a `huabu.chat` submission internally. `AgentThreadService` gains a canonical submission entry point, such as `invokeSubmission()`, so the trusted View Bridge can submit the preconstructed `huabu.interactive-view` variant directly. The iframe does not call or broaden the string-only RFS Agent prompt endpoint.

If the target thread has an active turn, the first implementation reuses `AgentThreadService`: it waits up to five seconds for the shared turn lease and then returns `thread_busy`. It does not create another Agent, queue silently, or bypass the lease. Optional durable buffered submission belongs in Agenetes and is tracked separately in [hai-team/agenetes#1](https://github.com/hai-team/agenetes/issues/1).

### 10.4 Navigation

Navigation actions target a Node or thread already present in a bound data row or fixed Action Grant. The iframe sends an opaque binding item ID rather than an arbitrary resource ID. Huabu resolves the current target, verifies that it belongs to the current Space, and performs native navigation.

Navigation has no server mutation and does not expose internal route construction to the iframe.

### 10.5 Future domain actions

Start, cancel, retry, pause, Canvas mutation, publication, credential use, paid operations, and destructive effects are not generic free-form calls. A future version may add named domain actions through the same registry, but each requires a shared wire schema, server authorization, explicit resource binding, structured outcome, and confirmation policy.

## 11. Data binding

### 11.1 Source registry

Bindings select from a closed host registry:

```typescript
interface ViewDataBindingV1 {
  bindingId: string;
  source:
    | {
        kind: 'canvas.task-store';
        recentRunLimit: number;
      }
    | {
        kind: 'canvas.nodes';
        nodeIds: readonly string[];
      };
}
```

The first Issue Tracker slice requires only `canvas.task-store`. The host projects bounded Task and Run fields, including Task ID, Run ID, status, root Node ID, root thread ID, timestamps, and goal summaries. It does not expose storage paths or internal records.

The registry is extensible in code but not dynamically programmable by an Agent. Adding a new source kind requires a shared schema and resolver.

### 11.2 Updates

Opening the View produces a full snapshot with a binding revision and explicit Host-derived Node/thread references. The host sends replacement snapshots when the underlying source changes.

The Task repository currently has no change subscription. Each binding declaratively chooses mount, focus, and optional polling refresh; polling intervals are constrained to 1–60 seconds and run only while the View is mounted and the document is visible. The Host Bridge schedules refresh and the iframe can request only a granted binding through `data.refresh`; it cannot supply a query, URL, callback, or timer. The Issue Tracker uses a five-second Task binding interval. A later Task Store notification port can replace polling without changing iframe intents.

Subscriptions exist only while the View is mounted. Unmount, Node deletion, Space switch, and application shutdown release every listener and timer.

### 11.3 Data is not authority

Bound rows are presentation snapshots. An action always re-resolves the current server resource by its opaque binding item ID and rejects stale or missing targets.

## 12. Creation and discovery

### 12.1 Agent-facing creation

RFS adds a resource-oriented Interactive View creation operation. Its request and response schemas live in `packages/shared/src/types/api/*`, and every input passes `safeParse`. `AGENTLET_TOKEN` authenticates the trusted Agentlet transport. The request supplies the owner thread for routing, normally from the caller's `HUABU_THREAD_ID` / `X-Huabu-Host-Thread-Id`, and the server verifies that the durable external thread exists in the current Canvas namespace without requiring a corresponding Agent Node.

The creation request references a previously uploaded same-Canvas HTML artifact, supplies the proposed state schema and initial state, requests bindings and actions, and provides normal Canvas placement. The server validates the complete definition, creates one Web Node containing the definition and state through the canonical Canvas command path, and returns its `nodeId`, derived View revision, and granted capabilities.

Creation may remain a resource-oriented RFS convenience operation because it validates the complete Interactive View contract before lowering one Web Node creation through the canonical Canvas executor. It does not coordinate a second persistent resource.

### 12.2 Agent-side state access

RFS exposes authenticated read and compare-and-swap update operations for trusted external Agents. The Agent can therefore inspect user-entered configuration before orchestration and update the owning Node's state without rewriting the renderer artifact.

Iframe access never uses these HTTP operations; it goes through the MessagePort bridge.

### 12.3 Selection and discovery

When the user selects an Anchor View and prompts the Agent, the existing selected-node context supplies its Node ID and file metadata. The Agent resolves that Node through the Interactive View RFS resource.

`viewKey` supports bounded discovery when no Anchor is selected. A query is scoped to the current Canvas and returns matching view identities; duplicate keys are reported rather than resolved arbitrarily. The Issue Tracker workflow should prefer an explicit selection, use a unique existing `issue-tracker` view when unambiguous, and otherwise ask the user or create a new empty Anchor View.

## 13. Issue Tracker validation slice

The Issue Tracker package ships no Huabu-specific application code. It contains its Agent Team manifest, canonical prompt, portable Skill adapter, HTML/CSS/JS renderer, state schema, and action definitions.

### 13.1 State

The Anchor View state starts as:

```json
{
  "codebasePath": "",
  "worktreeRoot": ""
}
```

The renderer presents two text inputs and a Save action. Saving performs `state.replace`; the Issue Tracker Agent receives a separate `configuration-saved` `agent.submit` action or reads the current state on its next turn. Empty or invalid configuration prevents orchestration in the Agent workflow, not through Issue Tracker-specific host code.

### 13.2 Tracking table

The View binds to `canvas.task-store` and renders Tasks and recent Runs. Rows may display goal, status, Task ID, Run ID, root Node, root thread, and timestamps.

Node and thread links use bound native navigation actions. The renderer never receives arbitrary navigation authority.

Issue-specific states such as `awaiting_confirmation`, `implementing`, or `awaiting_pr_authorization` remain in Issue Tracker-owned View State or Agent output. They do not expand the generic Phase 1 Task Run status model.

### 13.3 User-to-Agent interaction

The renderer declares actions such as:

```text
save-configuration → state.replace
configuration-saved → agent.submit(owner thread)
approve-plan → agent.submit(owner thread)
open-run-node → navigation.open-node(bound row target)
open-run-thread → navigation.open-thread(bound row target)
refresh-runs → data.refresh(task binding)
```

The Issue Tracker Agent receives the approved structured event in its existing conversation, creates the worktree and Task Run through normal RFS operations, and updates View State as needed. Huabu never interprets those workflow transitions.

## 14. Security and privacy

1. `AGENTLET_TOKEN` protects the RFS transport, and all authenticated external Agents are trusted under the current single-user threat model.
2. Thread IDs are routing metadata rather than security principals; the server validates current-Canvas existence but does not implement per-thread ACLs.
3. Interactive Views retain iframe sandboxing without `allow-same-origin`.
4. The bridge uses a per-mounted-iframe `MessagePort`; global messages do not execute actions.
5. View HTML never receives RFS tokens, cookies, API credentials, raw routes, or ambient host APIs.
6. Capability targets are persisted in the owning Node and fixed before iframe interaction.
7. Every intent is schema-validated, size-limited, rate-limited, correlation-tracked, and logged.
8. Duplicate `requestId` values are rejected or return the original idempotent outcome according to action policy.
9. State writes use a deterministic revision derived from the complete View definition and compare it inside the Canvas write mutex.
10. Data bindings are bounded by source-specific limits and current-Space authorization.
11. Iframe Agent submissions cannot select an arbitrary thread and continue to obey the shared per-thread turn lease.
12. Navigation resolves opaque bound targets and cannot open arbitrary URLs.
13. Renderer CSP blocks ungranted network access and external code by default.
14. Node deletion closes ports and invalidates its actions and bindings immediately.
15. User-entered local paths are visible only to the View and trusted Agent workflow; they are never inferred from or supplemented with host filesystem state.
16. Secret collection is outside the first-version state model. Agent Teams continue to use managed secret Configs rather than Interactive View fields.

## 15. Ownership and implementation boundaries

| Layer                                               | Responsibility                                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types/api/interactive-view.ts` | Zod-first creation, definition, state, binding, intent, outcome, and Agent-event contracts that are safe to share.                                 |
| Server Interactive View module                      | Definition validation, data-source registry, action dispatch, RFS adapters, mounted-view lifecycle, audit logging, and Agent-thread submission.    |
| Canvas executor                                     | Canonical creation, revision-checked update, persistence, undo/redo, sync, and deletion of the sole owning Web Node.                               |
| Web `InteractiveViewPreview`                        | Sandboxed iframe mounting, MessageChannel bootstrap, typed bridge client, outcome delivery, subscription disposal, and native navigation dispatch. |
| Task data-source adapter                            | Bounded projection over the canonical Canvas Task repository; no duplicated Task storage or orchestration semantics.                               |
| `AgentThreadService`                                | Canonical Chat/View submission entry points plus the existing turn lease, invocation, durable history, recovery, and lifecycle.                    |
| External Agent package                              | Renderer, state schema, requested grants, business labels, workflow, and interpretation of user events.                                            |

## 16. Failure semantics

- Missing or deleted renderer artifact: show an explicit unavailable View state while retaining the owning Node and its state for repair.
- Invalid View Definition: reject creation/update without persisting an invalid Interactive View Node.
- Unsupported protocol version: render a non-interactive compatibility error.
- State conflict: return current revision and require reload/reconciliation.
- Binding source unavailable: preserve the view and show a binding-scoped error without fabricating empty authoritative data.
- Thread missing or deleted: reject `agent.submit`; never create a replacement thread implicitly.
- Thread busy: wait through the existing lease policy for up to five seconds, then return `thread_busy`; do not queue silently.
- Agent turn failure: return a structured action failure while preserving the durable Agent transcript and View State.
- Iframe crash or reload: close the old port, establish a new port, and send fresh state/data snapshots.
- Node deletion: close the port and subscriptions; no separate View resource remains.
- Space switch or View unmount: dispose bridge resources without changing the owning Node.

## 17. Delivery plan

### Phase 1 — persistent view and bridge

- Extend local-HTML Web Node data with the versioned Interactive View definition and state.
- Add authenticated RFS creation, read, View-revision CAS update, and bounded discovery.
- Attach Interactive View capability only to local HTML Web Nodes.
- Add sandboxed MessageChannel bootstrap and full-value `state.replace`.

### Phase 2 — Agent interaction and navigation

- Extend the Huabu submission union with `huabu.interactive-view` and add a canonical `AgentThreadService` submission entry point.
- Add `agent.submit` using the existing structured Agenetes submission contract and canonical `AgentInput` rendering.
- Add bound Node/thread native navigation.
- Surface correlated action outcomes to the mounted iframe.

### Phase 3 — Task/Run projection

- Add the `canvas.task-store` data-source adapter.
- Add snapshots, explicit refresh, active-view lifecycle, and bounded update behavior.
- Validate the Issue Tracker table and links.

### Phase 4 — Issue Tracker demo

- Move the two path fields from Agent Team environment Configs into Anchor View State.
- Package the renderer and schema inside `agent-teams/issue-tracker/`.
- Update the Agent prompt to select, discover, create, read, and update the Anchor View.
- Demonstrate plan approval and continuation through the same external Agent thread.

### Phase 5 — generalization

- Evaluate a declarative component renderer against the proven bridge.
- Add further data sources or domain actions only with explicit shared contracts and authorization.
- Replace Task polling with repository notifications if active-view demand justifies it.

## 18. Acceptance criteria

- An external Copilot or Claude Agent can create an Interactive View from package-owned HTML without adding package-specific Huabu code.
- User-entered View State survives iframe reload, Node close/reopen, Space reload, and application restart.
- The owning Node is the only View identity and persistence resource; no separate View repository, revision, tombstone, or cleanup transaction exists.
- The iframe never receives an RFS token, cookie, raw API route, arbitrary Thread target, or ambient host capability.
- A user action reaches the pre-bound external Agent thread as a validated durable View Event.
- Existing thread leases, history, and recovery remain authoritative; Agent Node lifecycle is updated only when the owner Thread has a fixed Agent Node target.
- A bounded Task/Run projection updates independently from the persisted HTML artifact.
- Bound Node and thread links open through native Huabu navigation.
- Unknown, malformed, stale, oversized, unauthorized, replayed, and rate-limited intents fail explicitly before reaching an application service.
- Existing remote Web Nodes, snapshots, reader views, and ordinary HTML artifacts behave unchanged.
- The Issue Tracker demo reads its two paths from Anchor View State, creates worktrees and Runs through existing RFS capabilities, displays Task/Run identities, and uses the same Agent thread for user approvals.
- Removing the Issue Tracker Agent Team package leaves no Issue Tracker-specific types, routes, components, handlers, or persistence in Huabu.

## 19. Deferred question

The first implementation is not blocked on renderer standardization. After the HTML bridge and Issue Tracker validation slice are proven, evaluate whether a declarative renderer should align with an external A2UI standard or remain a Huabu/package-owned concern.

## 20. Related documents

- [`long-horizon-tasks.md`](./long-horizon-tasks.md) — current Task, Run, visible Agent Node, and recursive Agent invocation model.
- [`../architecture/agent-reachback.md`](../architecture/agent-reachback.md) — current RFS authentication and external-Agent capability surface.
- [`../architecture/question-node.md`](../architecture/question-node.md) — visible Agent Node and durable thread ownership.
- [`../architecture/api-design.md`](../architecture/api-design.md) — authoritative HTTP/SSE contract and validation rules.
- [`../architecture/web-architecture.md`](../architecture/web-architecture.md) — frontend layering, common-component, and semantic-token requirements.

## 21. Proposed code entry points

| File/dir                                                       | Responsibility                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/shared/src/types/api/interactive-view.ts`            | Canonical schemas and inferred wire types.                                               |
| `packages/shared/src/types/canvas/node.ts`                     | Interactive Web Node definition and persisted state shape.                               |
| `apps/server/src/modules/interactive-view/`                    | Validation, grants, data bindings, action dispatch, RFS adapters, and runtime lifecycle. |
| `apps/web/src/components/Nodes/web/InteractiveViewPreview.tsx` | Sandboxed renderer host and MessageChannel bridge.                                       |
| `apps/web/src/api/interactive-view.ts`                         | Host web-client operations required outside the iframe bridge.                           |
| `apps/server/src/modules/agent/agent-thread.service.ts`        | Canonical structured-submission entry point for Chat and Interactive View turns.         |
| `agent-teams/issue-tracker/`                                   | Validation package containing the external Agent workflow and package-owned renderer.    |
