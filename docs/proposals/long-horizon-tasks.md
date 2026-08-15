# Long-Horizon Tasks on Huabu

> Define the minimum platform capability for a Canvas-scoped task to start one visible Agent thread, let that Agent recursively create and invoke more visible Agent threads, and exchange durable information through conversations and Space nodes.
>
> Status: **Partly shipped** · Last updated: 2026-08-15

---

## 1. Epic

As a Huabu user, I want to express a substantial goal in one Space, let an Agent continue the work through other Agents when useful, and return to a legible graph of Agent conversations and durable work products instead of receiving only one opaque final response.

The defining product promise is:

> A long-running task should leave behind a legible graph of work, not merely a long transcript.

This proposal deliberately focuses on the bottom-layer capability and information pipeline rather than a complete task product. The first implementation creates a Canvas-scoped Task and static Task Note, starts a Run through one root Agent Node and thread, lets any participating Agent recursively create and invoke more Agent Nodes and threads, and reuses the existing RFS query, execution, artifact, and Agent streaming surfaces for communication.

The first implementation did not attempt to define when a Run is semantically complete, build a workflow engine, or solve scheduling, cancellation, approvals, notifications, cross-Space execution, or a complete Task UI. A later completion slice added an explicit guarded `running → completed` transition without deriving completion from Agent turn termination.

## 2. Design principles

### 2.1 Build a capability and information pipeline

The core pipeline is:

```text
Task in one Canvas
  → Run root Agent Node / thread
  → recursively created Agent Nodes / threads
  → synchronous AgentStreamEvent responses
  → durable conversation history
  → optional Space nodes / artifacts for reusable work products
```

Huabu provides the mechanism to create, invoke, display, and continue Agent threads. Agents decide whether to work directly, delegate, create another working directory, use another Profile, or materialize a result as a Space node.

### 2.2 Reuse RFS

Every Task is scoped to one explicitly selected Canvas in Phase 1. Its root and delegated Agents receive the existing Canvas-scoped RFS environment and reuse the current `query`, `execute`, `download`, `upload`, snapshot, artifact, and `agent` capabilities.

Phase 1 adds only one new Agent-facing creation operation and extends the existing RFS Agent invocation path beyond its current live internal-thread restriction so it can lazily realize and invoke Profile-backed Agent Nodes.

### 2.3 Threads are visible

Every durable thread created by this capability has exactly one visible Agent Node. Phase 1 persists that Agent Node with the existing `question` node type and reuses its conversation UI, history, search, Agent identity, status presentation, and continuation behavior.

There are no hidden orchestration threads in this model.

### 2.4 Root and delegated Agents use one model

Every Run has one root Agent Node and thread. A root thread and a delegated thread are not different Agent types: they use the same creation and invocation services, and any Agent may recursively create another Agent.

The terms root and delegated describe a relationship, not a fixed coordinator/worker role model.

### 2.5 Thread identity is `threadId`

A globally unique `threadId` is the identity and address of an Agent thread. The existing Canvas namespace remains an internal persistence-placement detail while Agenetes still requires it.

Removing the legacy Namespace parameter from Agenetes thread APIs is the non-blocking follow-up [#58](https://github.com/microsoft/Huabu/issues/58). It is not a prerequisite for this proposal.

## 3. Product vocabulary

| Term                     | Meaning                                                                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task**                 | A durable user goal bound to one Canvas, with a static Task Note anchor and default root Agent Profile. A Task may have multiple concurrent Runs.                                                                                        |
| **Run**                  | One execution instance of a Task. Each Run creates a new root Agent Node and thread.                                                                                                                                                     |
| **Task Store**           | The source of truth for canonical Task and Run records. Phase 1 keeps this model intentionally small.                                                                                                                                    |
| **Task Note**            | An ordinary Note created once as the visible anchor for a Task. It is not a live Task/Run status projection in Phase 1.                                                                                                                  |
| **Run Launcher**         | A thin Huabu Server component that creates a Run, creates its root Agent Node through the shared Agent Node service, starts the first root turn, and changes the Run from `pending` to `running`. It is not an Agent or workflow engine. |
| **Agent Node**           | The visible one-to-one Canvas anchor for one durable Agent thread. Phase 1 uses the existing persisted `question` node type.                                                                                                             |
| **Root Agent**           | The first Agent Node and thread created for one Run. It is the Run's initial execution entry point.                                                                                                                                      |
| **Delegated Agent**      | An Agent Node and thread created by another Agent. It may work directly or recursively create more Agents.                                                                                                                               |
| **Agent Profile**        | An available Agent configuration selected by `profileId`. The public `huabu` Profile is the default; other Profiles compile into external WorkloadSpecs.                                                                                 |
| **Agent invocation**     | A synchronous RFS call that submits input to an existing thread and streams its `AgentStreamEvent`s to the caller.                                                                                                                       |
| **Conversation handoff** | Information returned through the Agent event stream and durably preserved in the target Agent Node's thread history.                                                                                                                     |
| **Space handoff**        | A reusable work product materialized as an ordinary node or artifact and optionally connected to its inputs.                                                                                                                             |

## 4. Phase 1 boundary

Phase 1 makes the following decisions:

- A Task belongs to exactly one existing Canvas.
- All Runs, Agent Nodes, ordinary output nodes, and artifacts created for the Task remain in that Canvas.
- A Task may have multiple concurrent Runs.
- Each Run creates a new root Agent Node and globally unique root `threadId`.
- Any Agent thread may recursively create another Agent Node and thread.
- Every created thread has exactly one Agent Node; root and delegated threads use the same node type and service.
- Agent Node creation and Agent invocation are separate operations.
- New Agent Nodes use the default `huabu` Profile or another available Agent Profile.
- Creation may apply bounded `workingDirPath` and `additionalInitialPreamble` overrides to the Profile-derived WorkloadSpec.
- Overrides replace the corresponding compiled external WorkloadSpec values for both `acp-command` and `agent-team-manifest` Profile launch kinds; they do not introduce a separate Profile setup or installation lifecycle.
- Free-form Agent Node creation may supply an explicit Canvas-root `position`; otherwise the Server chooses one.
- A requested parent-to-child edge is best effort and never blocks or rolls back Agent Node creation.
- Conversation streams are always durable handoffs; ordinary Space nodes and artifacts are optional structured handoffs chosen by the Agent workflow.
- Agent turns continue after the invoking HTTP connection closes. Explicit stop remains the only Phase 1 abort path.
- The Task Note is a static ordinary Note anchor, not a continuously refreshed status projection.
- The Task Store is a Canvas-scoped server storage port backed on Disk by `<canvasDir>/.history/tasks.json`; it is not embedded in `space.json` or represented by Canvas nodes.
- Run status has only `pending` and `running` in Phase 1.
- `running` means that the root thread's first turn has started. Phase 1 does not define a Run completion state or map turn termination to Run termination.
- The Server is authoritative for Question Node content and lifecycle updates made by headless, RFS, and UI invocations.
- A created but never-invoked Agent Node remains `idle`, displays its bound Agent identity, and opens the existing compose UI with `agentBindingPolicy: fixed`; ordinary user-created Question Nodes default to `selectable`.
- Profile lowering remains on the current `runAcpAgent()` path in Phase 1; moving it to `agentProfileDriverFactory` is a separate refactor.
- The only Phase 1 Task operations are Task creation and Run creation. Built-in Agent tools and Canvas-scoped RFS endpoints expose both operations over shared contracts; `startImmediately` may compose them.
- Phase 1 does not expose other Task state commands through tools or RFS.

## 5. Reference flow

### 5.1 Create a Task

An initiating Agent already scoped to one Canvas creates a Task with a goal, a default root Profile, and a position for its ordinary Task Note. A built-in Agent uses the `create_task` tool; an external Agent uses the Canvas-scoped RFS Task creation endpoint.

The Server persists the Task, creates the Task Note, and stores its `anchorNodeId`. The Note is immediately visible and contains the user goal. The Server does not continuously rewrite it as the Run changes.

Task creation may request `startImmediately`; this is a convenience composition over the separate Run creation operation exposed through the corresponding built-in tool and RFS adapter.

### 5.2 Create and start a Run

Creating a Run persists a new `pending` Run with a snapshot of the Task goal, target Canvas, and effective root Profile selection.

The Run Launcher computes an explicit root Agent Node position from the Task anchor context and calls the same `AgentNodeService.create()` used by delegated creation. The root has no parent thread.

The service creates a `question` node with a new `threadId`, the selected external `agentBinding`, and any launch overrides, then connects the Task Note to the root Agent Node.

The Run Launcher starts the first root turn through `AgentThreadService.invoke()`. Once that turn begins, it changes the Run to `running`.

The Run Launcher does not interpret the Agent's plan, repeatedly choose actions, or decide when the Run is complete.

### 5.3 Create an Agent

An Agent that needs a new visible conversation calls:

```http
POST /api/rfs/:canvasId/agent
Authorization: Bearer $AGENTLET_TOKEN
X-Huabu-Agent-Start: false
Content-Type: application/json
```

```json
{
  "profileId": "profile-id",
  "parentThreadId": "optional-parent-thread-id",
  "position": { "x": 1200, "y": 480 },
  "workingDirPath": "/optional/absolute/path",
  "additionalInitialPreamble": "Optional durable role instructions."
}
```

`parentThreadId` may be omitted or supplied through `X-Huabu-Host-Thread-Id`. It is a lineage hint, not a permission model.

The Server validates the Canvas, Profile, optional position, and bounded overrides, then creates a new `question` node. Parent lookup and edge creation run afterward as best effort. The response reports creation and lineage separately:

```json
{
  "nodeId": "node-id",
  "threadId": "thread-id",
  "profileId": "profile-id",
  "parentConnection": "connected",
  "warnings": []
}
```

With `X-Huabu-Agent-Start: false`, creation does not submit a prompt or run the Agent. Otherwise the request includes `prompt`, returns SSE beginning with the same creation metadata, and starts the first turn.

### 5.4 Prompt an existing Agent

The caller submits later turns through the thread-addressed RFS surface:

```http
POST /api/rfs/:canvasId/agent/<targetThreadId>/prompt
Authorization: Bearer $AGENTLET_TOKEN
X-Huabu-Event-Mode: all
```

The call remains synchronous and streams the child turn's `AgentStreamEvent`s. The existing per-thread turn lease continues to reject overlapping calls with `thread_busy`.

The RFS route delegates to the shared `AgentThreadService.invoke()` rather than calling a live handle directly. The service resolves the Agent Node, realizes its Huabu or external workload on first invocation, and reuses or recovers the persisted workload on later turns.

On the first successful invocation, `AgentThreadService` persists the submitted user text as the Question Node's `content`, changes its status to `running`, and retains the creation-time Agent binding. Terminal turn events update the node to `done` or `error` through the same server-owned lifecycle path used by UI invocation.

The current RFS raw-text and JSON prompt forms remain the Phase 1 submission surface. Closing the invoking HTTP connection stops delivery to that caller but does not abort the turn; explicit stop is the only abort path. No asynchronous mailbox, invocation resource, polling protocol, or second Agent-to-Agent transport is introduced.

### 5.5 Continue from the UI

A headlessly created Agent Node must open in the existing Question Node conversation UI, replay the same Agenetes history, and accept a follow-up through the existing Chat flow.

UI and RFS invocations must share the same `AgentThreadService`, WorkloadSpec, turn lease, event log, folded history, and Node lifecycle updates. Headless execution must not create a parallel conversation store or a long-task-specific Agent UI.

Before its first invocation, the Agent Node uses the existing `idle` state and compose presentation. Its creation-time external Agent binding carries `agentBindingPolicy: fixed`, so opening it lets the user submit the first turn but does not repurpose the node with a different Profile. An absent policy means `selectable` for compatibility with ordinary user-created Question Nodes.

## 6. Key API and internal method inventory

The rows below are capabilities rather than endpoints. Phase 1 adds no Task-specific UI HTTP API: the existing Chat UI reaches Task capabilities through its selected Agent. Built-in Agent tools and external-Agent RFS endpoints are parallel adapters over the same shared contracts and internal methods, following the existing `space_commands` tool plus RFS `/execute` pattern.

| Capability                      | UI-facing HTTP                                                | Agent-facing adapter                                                                                    | Internal calling method                                                                                                | Responsibility                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create Task                     | Existing Chat UI; no Task-specific UI HTTP API                | Built-in `create_task` tool **(new)** or `POST /api/rfs/:canvasId/task/create` **(new)**                | `TaskService.create(canvasId, input)` **(new)**                                                                        | Persist one Canvas-scoped Task and its static Task Note; `startImmediately` may compose the Run-start capability.                                                         |
| Start Run                       | Existing Chat UI; no Task-specific UI HTTP API                | Built-in `start_task_run` tool **(new)** or `POST /api/rfs/:canvasId/task/:taskId/run/create` **(new)** | `RunLauncher.start(taskId, input)` **(new)**                                                                           | Create a `pending` Run, create its root Agent Node, invoke the first root turn, and record `running` once the turn starts.                                                |
| Create Agent Node and thread    | Indirect through Start Run for the root Agent                 | `POST /api/rfs/:canvasId/agent`                                                                         | `AgentNodeService.create(input)`                                                                                       | Create the visible `question` node, globally unique `threadId`, Profile binding, launch overrides, and optional best-effort parent edge; optionally start the first turn. |
| Invoke or continue Agent thread | `POST /api/agent` **(existing, refactored to shared method)** | `POST /api/rfs/:canvasId/agent` **(extended)**                                                          | `AgentThreadService.invoke(threadId, submission, context)` **(new)** → `Agenetes.create(spec).run(...)` **(existing)** | Lazily realize or cold-recover the Profile-backed Deployment, enforce the shared turn lease, stream events, persist history, and update Question Node lifecycle state.    |
| Replay Agent conversation       | `GET /api/agent/history/:threadId` **(existing)**             | Invocation returns the live child stream; no separate Agent-facing history API                          | `Agenetes.history(namespace, threadId)` **(existing compatibility API)**                                               | Replay the same persisted turns in the existing Question Node UI; follow-up [#58](https://github.com/microsoft/Huabu/issues/58) removes the legacy Namespace argument.    |
| Read Space inputs               | Existing Canvas read surfaces                                 | `POST /api/rfs/:canvasId/query` and `GET /api/rfs/:canvasId/download/<path>` **(existing)**             | Existing Space query and file-projection services                                                                      | Read topology, metadata, node content, search results, snapshots, artifacts, and staged uploads.                                                                          |
| Write Space handoffs            | Existing Canvas command surfaces                              | `POST /api/rfs/:canvasId/execute` and `POST /api/rfs/:canvasId/upload/<name>` **(existing)**            | Existing Canvas command executor and upload staging service                                                            | Create or update ordinary handoff nodes and edges and stage artifact payloads through the canonical Canvas paths.                                                         |

`TaskService.create()`, `RunLauncher.start()`, `AgentNodeService.create()`, and `AgentThreadService.invoke()` are the canonical application methods. Built-in tools and RFS routes adapt the same shared contracts to these methods rather than implementing separate Task or Agent paths.

## 7. Agent Node creation contract

### 7.1 Shared service

`AgentNodeService.create()` is a Huabu application service above the Canvas engine and Profile registry. It is used internally by the Run Launcher and through the RFS `/agent` adapter.

The internal service accepts either the Task Note anchor for a root Agent or the parent Agent Node for a delegated Agent. The RFS adapter derives the latter from `X-Huabu-Host-Thread-Id`; the Run Launcher supplies the former directly.

The service owns:

- generating the Agent Node ID and globally unique `threadId`;
- resolving the selected Profile's display binding;
- persisting a `question` node with empty initial content;
- persisting bounded launch overrides;
- applying an explicit root-level Canvas position;
- creating the Task-Note-to-root or parent-Agent-to-child edge;
- returning `{ canvasId, nodeId, threadId }` internally; the Canvas-scoped RFS adapter omits the already-known `canvasId` and returns `{ nodeId, threadId }`.

The service does not invoke the Agent.

### 7.2 Lazy realization

`POST /agent` persists the Agent Node, `threadId`, binding, and launch overrides before any optional first turn begins.

On first invocation, `AgentThreadService` resolves `profileId`, compiles the external Profile into its WorkloadSpec, applies the persisted overrides, and calls Agenetes. Agenetes then persists the thread record and conversation events through the normal Deployment path.

After first realization, the persisted WorkloadSpec is the runtime recovery source. Later Profile changes do not silently alter that thread.

If the Profile no longer exists before first invocation, invocation fails explicitly and the visible Agent Node remains available for inspection.

The Phase 1 implementation keeps Profile resolution and lowering on the existing `runAcpAgent()` path. Consolidating that lowering into `agentProfileDriverFactory` is not required to introduce the shared invocation service and must not be bundled into these delivery slices.

### 7.3 Launch overrides

Question Node data gains a separate optional launch field rather than widening the shared `AgentBinding` contract:

```ts
interface AgentLaunchOverrides {
  workingDirPath?: string;
  additionalInitialPreamble?: string;
}
```

`workingDirPath` must be an absolute path no longer than 4096 characters. `additionalInitialPreamble` must be non-empty when present and no longer than 16 KiB.

`workingDirPath` replaces the compiled external WorkloadSpec's effective cwd for that thread. `additionalInitialPreamble` is appended to the Profile-derived initial instructions after Huabu's mandatory external-Agent access preamble.

Task-specific user input, issue text, repository content, and other changing inputs remain in the first submission rather than the immutable initial preamble.

### 7.4 Uninvoked Node semantics

An Agent Node created by the Run Launcher or another Agent is persisted with sparse idle status, empty `content`, a generated `threadId`, a creation-time external `agentBinding`, and `agentBindingPolicy: fixed`. The existing Question Node UI renders it as ready to start rather than completed or running.

Opening an uninvoked Agent Node enters the existing compose flow with its Agent selector locked to the persisted binding. Ordinary Question Nodes without a policy remain selectable until their first turn. The first invocation may come from that UI or RFS; both paths persist the first submitted user text into `content` and then use the same server-owned lifecycle updates.

## 8. Invocation and persistence ownership

Huabu and Agenetes have separate responsibilities:

| Layer                  | Responsibility                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run Launcher**       | Create a Run, create its root Agent Node, start its first turn, and record `pending → running`.                                                                                                      |
| **AgentNodeService**   | Create the visible Node/thread binding and delegation edge without invoking the Agent.                                                                                                               |
| **AgentThreadService** | Resolve an Agent Node by `threadId`, compile or recover its external WorkloadSpec, acquire the shared turn lease, invoke the handle, stream events, and update the existing Question Node lifecycle. |
| **Agenetes**           | Realize or recover the workload, run the turn, persist events and folded conversation history, and expose the live handle.                                                                           |
| **RFS**                | Provide the Canvas-scoped Agent-facing adapters and existing Space read/write/artifact operations.                                                                                                   |

The existing Canvas namespace may still be reconstructed internally when calling current Agenetes durable APIs. Callers address Agents by `threadId`; the Namespace compatibility detail must not appear in the new RFS contract.

### 8.1 Task Store persistence

`TaskStore` is an asynchronous Canvas-scoped storage port owned by Huabu Server. The Disk adapter persists one versioned record at `<canvasDir>/.history/tasks.json` containing the Canvas's canonical Task and Run records.

The minimal Task record contains `taskId`, `canvasId`, `goal`, `defaultRootProfileId`, `anchorNodeId`, and `createdAt`. The minimal Run record contains `runId`, `taskId`, `canvasIdSnapshot`, `goalSnapshot`, `rootProfileIdSnapshot`, `status`, optional `rootNodeId` and `rootThreadId` until creation completes, `createdAt`, and optional `startedAt`.

The Disk adapter serializes writes with a per-Canvas process-local mutex and replaces the file atomically. Task and Run records do not enter `space.json`, so starting a Run does not contend with Canvas topology version CAS; the Task Note and Agent Nodes remain ordinary Canvas records written through the existing authoritative Canvas mutation path.

Phase 1 does not add query indexes, event sourcing, or a general workflow repository. A later storage backend may implement the same `TaskStore` port without changing `TaskService` or `RunLauncher`.

## 9. Visible lineage and handoff

### 9.1 Delegation edges

Every delegated Agent Node is automatically connected from its parent Agent Node. Every root Agent Node is connected from the Task Note.

These ordinary Canvas edges make the delegation tree visible but do not control execution. Moving or deleting an edge does not close, cancel, or rebind a thread.

### 9.2 Conversation handoff

Every invocation produces a durable conversation handoff because Agenetes persists the child thread's input and events. The parent receives the same output synchronously through RFS, while the user can later inspect the complete child conversation through its Agent Node.

### 9.3 Space handoff

An Agent may use the existing RFS `query`, `download`, `execute`, upload, and artifact surfaces to materialize reusable results as ordinary nodes or artifacts.

When a result will be reused independently, inspected spatially, or consumed by another Agent after the immediate call, the Agent workflow should prefer a Space handoff and return the resulting node IDs and revisions. This is a workflow convention, not a mandatory server-side requirement for every invocation.

## 10. Validation scenarios

### 10.1 Recursive Agent pipeline

1. A user creates a Canvas-scoped Task and starts a Run.
2. A static Task Note and root Agent Node appear with an edge between them.
3. The root thread starts headlessly and the Run becomes `running`.
4. The root Agent creates another Agent through `POST /agent`.
5. The delegated Agent Node appears at the requested position with an automatic edge from the root.
6. The root invokes the delegated thread through the existing RFS `POST /agent` SSE surface.
7. The child conversation is replayable from its Agent Node.
8. The child may create an ordinary result node, return its ID, or return only a durable conversation result.
9. The delegated Agent may recursively create and invoke another Agent through the same APIs.
10. The user can open any created Agent Node and continue its existing thread through the normal Question Node UI.

### 10.2 Auto-research

The root Agent receives a paper-related goal, creates discovery and research Agents when useful, and passes information through their streams and ordinary source/analysis/direction nodes.

The platform does not require a fixed acquisition-worker/research-worker topology. One Agent may do all work, or Agents may recursively delegate according to the available Profiles and task needs.

### 10.3 Issue fixing

The root Agent receives an issue and local repository context. It may create a collision-free branch and Git worktree, then create another Agent with `workingDirPath` overridden to that worktree.

Different Tasks or Runs may use separate branches and worktrees so concurrent fixes do not share a Git index, untracked files, build output, or working directory. Merge conflicts between branches remain ordinary Git integration concerns.

The platform does not run Profile setup or installation because a cwd override was supplied. It compiles the selected Profile, applies the override, and starts the new thread with the resulting spec.

Pushing, opening a pull request, closing an issue, or deleting a dirty worktree remains outside this capability and requires a separately designed user action.

The earlier issue-fixer and runtime-bootstrap discussions live in the previous repository: [Sediment #426](https://github.com/hai-team/Sediment/issues/426) and [Sediment #429](https://github.com/hai-team/Sediment/issues/429).

## 11. Acceptance criteria

1. Built-in `create_task` and RFS `POST /task/create` validate the same shared contract and call the same `TaskService.create()` method.
2. Built-in `start_task_run` and RFS `POST /task/:taskId/run/create` validate the same shared contract and call the same `RunLauncher.start()` method.
3. A Task can be created in one existing Canvas with a static ordinary Task Note.
4. A Task may own multiple concurrent Runs.
5. Every Run creates a fresh root Agent Node and globally unique thread.
6. The Run Launcher starts the root turn without a rendered Canvas or browser connection and records `pending → running`.
7. Every thread created by this capability has exactly one persisted `question` node.
8. Root and delegated Agents use the same `AgentNodeService` and `AgentThreadService`.
9. Any Agent may recursively create another Agent through `POST /api/rfs/:canvasId/agent`.
10. Agent creation defaults to the `huabu` Profile; position and parent-thread lineage are optional.
11. Agent creation accepts bounded cwd and initial-preamble overrides for both external Profile launch kinds.
12. Agent creation returns `{ nodeId, threadId }` without starting a turn.
13. A created but uninvoked Agent Node is `idle`, displays its persisted Agent identity, and opens compose with its binding locked.
14. First invocation lazily realizes the Profile-derived WorkloadSpec with overrides applied and persists the first submitted user text as Question Node content.
15. Existing RFS `POST /agent` is extended to lazily realize or recover the created Profile-backed thread and stream its standard events.
16. Disconnecting an invoking UI or RFS client does not abort the turn; the explicit stop path still does.
17. The same per-thread turn lease prevents overlapping UI and RFS turns.
18. Headless and UI invocation write the same Agenetes history and use the same server-owned Question Node lifecycle.
19. A headlessly created Agent Node can be opened, replayed, and continued through the existing Question Node UI.
20. Agent creation attempts an ordinary parent-to-child Canvas edge when a parent thread is supplied, without failing creation if lineage cannot be established.
21. Agents can continue using existing RFS query, execution, download, upload, snapshot, and artifact operations.
22. Conversation-only results remain durable, while Agent workflows may additionally materialize reusable node/artifact handoffs.
23. Agent-facing APIs use `threadId` as the thread address and do not expose the legacy Agenetes Namespace object.
24. Task and Run records persist through the Canvas-scoped `TaskStore` without changing `space.json`.
25. Phase 1 adds no Task-specific UI HTTP API and does not require a completed Run state, Task projection repair, additional Task state commands, scheduler, workflow queue, or cross-Canvas execution.

## 12. Non-goals

- Defining a complete Task lifecycle beyond `pending → running`.
- Deciding when a root turn or collection of Agent turns makes a Run complete.
- Building a general workflow engine, durable action queue, event-sourced Task FSM, scheduler, or agent mailbox.
- Defining retries, pause, cancel, resume, waiting-for-user, blocked, failed, or completed Run semantics.
- Building Task Note live projection, projection repair, or a dedicated Task node type.
- Implementing scheduled, recurring, on-open, or webhook triggers; the earlier discussion is [Sediment #342](https://github.com/hai-team/Sediment/issues/342).
- Implementing workspace-level intake, automatic target-Space selection, or cross-Canvas Agent creation and mutation.
- Introducing coordinator and worker as fixed server-understood Agent roles.
- Requiring every Agent invocation to create an ordinary result node.
- Adding an asynchronous invocation queue, polling resource, or durable mailbox.
- Refactoring Agenetes Namespace-based durable lookup as part of this work; follow-up [#58](https://github.com/microsoft/Huabu/issues/58) owns that cleanup.
- Running Profile setup, skill installation, tool installation, file copying, or custom install hooks because a cwd override was supplied.
- Building a dedicated Task UI or Agent-authored interactive Task view; the earlier interactive-view exploration is [Sediment #431](https://github.com/hai-team/Sediment/issues/431).
- Defining multi-user, multi-tenant, or inter-Agent permission isolation. Huabu remains a single-user personal tool whose Agentlet token protects the communication channel.
- Automatically pushing, publishing, merging, deleting workspaces, or performing other external or destructive actions.

## 13. Resolved implementation decisions

| Topic                      | Phase 1 decision                                                                                          | Reason                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Caller disconnect          | Continue the turn; only explicit stop aborts it.                                                          | This preserves the current `/api/agent` behavior and is required for useful headless work.                  |
| Task persistence           | Use a Canvas-scoped `TaskStore` with a Disk record at `.history/tasks.json`.                              | It keeps the Space self-contained without adding topology CAS contention or a workflow database.            |
| Question lifecycle         | `AgentThreadService` owns first-content, `running`, `done`, and `error` writes for every invocation path. | UI, RFS, and headless runs must not create competing lifecycle authorities.                                 |
| Uninvoked Agent Node       | Render as `idle` and use explicit `agentBindingPolicy: fixed`; absent policy remains `selectable`.        | Binding identity and binding mutability are separate, so future UI-created prebindings remain editable.     |
| Profile lowering           | Keep `runAcpAgent()` lowering in place.                                                                   | Driver-factory consolidation is independent and would enlarge the critical path.                            |
| Run completion and control | Design after the creation/invocation pipeline ships and produces operational evidence.                    | Completion, cancellation, recovery, and waiting-for-user semantics form a separate lifecycle product slice. |

## 14. Delivery slices

The slices below are dependency-ordered and intended to merge sequentially. Each slice leaves one canonical path in place and avoids temporary Task-specific Agent execution code.

### 14.1 Agent Node foundation

Add `AgentLaunchOverrides` to Question Node data, implement `AgentNodeService.create()`, require explicit positions, create root/delegation edges, and add the locked-binding `idle` presentation for uninvoked Agent Nodes.

### 14.2 Canonical Agent thread invocation

Implement `AgentThreadService.invoke()` over the existing Question Node binding and Agenetes path, move the existing UI `/api/agent` execution behind it, and make first-content persistence, turn lease, history, disconnect behavior, and lifecycle updates server-owned. Support lazy first realization with Profile overrides without refactoring Profile lowering. The implementation uses a thin `canvasId + threadId` resolver whose Canvas scan is intentionally isolated for replacement by the Workspace-global DB index tracked in #60, a serialized Canvas lifecycle writer, and the existing Profile lowering extended with launch overrides. The UI route now delegates lease and dispatch to this service, and Web lifecycle writes filter fixed Agent Nodes down to client-owned `viewed` state; RFS adoption remains in Slice 14.3.

### 14.3 Recursive Agent RFS

Add `POST /api/rfs/:canvasId/agent` for visible Agent creation and `POST /api/rfs/:canvasId/agent/:threadId/prompt` for subsequent turns. The host-thread correlation header remains an optional lineage hint; disconnect stops delivery rather than the turn, and the shared explicit stop path can still abort it.

### 14.4 Canvas-scoped Task launch

Add the `TaskStore` port and Disk adapter, shared Task/Run schemas, static Task Note creation, `TaskService`, and `RunLauncher` with only `pending → running`. Then add the built-in Task tools and Canvas-scoped RFS Task/Run adapters over those same methods.

### 14.5 End-to-end validation and documentation

Validate recursive Agent creation, Question Node replay and continuation, an auto-research handoff, and an issue-fixer worktree cwd override without adding workflow lifecycle features.

### 14.6 Explicit Run completion

Add `RunCompletionService` and an atomic `SpaceTaskRuns.complete()` transition shared by the built-in `complete_task_run` tool and `POST /api/rfs/:canvasId/task/:taskId/run/:runId/complete`. Completion is an explicit caller decision, accepts optional immutable caller-owned context, treats same-message retries as idempotent, and does not infer completion from Agent turn lifecycle. Cancellation, recovery, waiting-for-user, and richer workflow semantics remain separate slices.

## 15. Code entry points

| File/dir                                                                                     | Current responsibility relevant to this proposal                                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`apps/server/src/modules/agent/`](../../apps/server/src/modules/agent/)                     | Built-in and external Agent entry points, Profile lowering, durable turns, and headless execution |
| [`apps/server/src/modules/remote_fs/`](../../apps/server/src/modules/remote_fs/)             | Canvas-scoped RFS query, execution, artifact, and Agent streaming surfaces                        |
| [`apps/server/src/modules/canvas/`](../../apps/server/src/modules/canvas/)                   | Server-authoritative Canvas execution, node/edge creation, sync, and routing                      |
| [`apps/web/src/components/Nodes/question/`](../../apps/web/src/components/Nodes/question/)   | Existing Agent Node presentation, conversation entry, and lifecycle UX                            |
| [`packages/shared/src/types/canvas/node.ts`](../../packages/shared/src/types/canvas/node.ts) | Existing `QuestionNodeData` contract to extend with launch overrides                              |
| [`packages/shared/src/types/api/`](../../packages/shared/src/types/api/)                     | Canonical zod-first Task and RFS wire contracts                                                   |
| [`external/agenetes/packages/`](../../external/agenetes/packages/)                           | Workload realization, Profiles, drivers, event logs, history, and replay                          |
| [`agent-teams/paper-scout/`](../../agent-teams/paper-scout/)                                 | Existing bounded academic discovery capability                                                    |
| [`agent-teams/paper-reviewer/`](../../agent-teams/paper-reviewer/)                           | Existing paper-reading and review capability                                                      |

## Related documents

- [Huabu Layered Architecture](./layered-architecture.md)
- [Managed Agent Teams](./managed-agent-teams.md)
- [Direct Space Operations](./direct-space-operations.md)
- [Agent architecture](../architecture/agent-architecture.md)
- [Agent Reachback](../architecture/agent-reachback.md)
- [Question Node](../architecture/question-node.md)
- [Canvas real-time sync](../architecture/canvas-realtime-sync.md)
