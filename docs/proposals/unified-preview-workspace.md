# Unified Preview Workspace

Status: Shipped
Last updated: 2026-08-20

The shipped system is documented in [`docs/architecture/preview-workspace.md`](../architecture/preview-workspace.md). This proposal is retained as design and migration history and is not authoritative for current behavior.

## 1. Summary

Replace the separate right-side Chat Panel and centre-area Expanded Node Panel with one Preview Workspace that hosts node previews and unbound chats in tabs.

The workspace contains one or two horizontally arranged tab groups. Each group owns multiple tabs and one active tab, matching the editor model where tabs and split panes coexist rather than acting as mutually exclusive modes.

Chat is a renderer, not a top-level workspace view type. A Question node opens as an ordinary node preview whose renderer is the existing conversation UI, while a chat without a Question node opens as an unbound-chat target using the same renderer.

The shipped implementation makes Preview Workspace the default and only Canvas preview presentation. It removes the feature flag, Settings toggle, centre-area Expanded Node layout, single-panel Chat fallback, global Chat thread/replay pointer, and replay save/restore stack. `ChatPanel` remains the canonical conversation renderer rather than being renamed to `ChatPreview`; `PreviewRenderer` supplies its required `ChatSession` and owning tab ID. This preserves one implementation of the existing feature-rich conversation UI without introducing a wrapper that only changes naming.

## 2. Current system

The current Canvas page has two independent presentation paths:

- `MainLayout` mounts one `ChatPanel` in a collapsible right column.
- `CenterArea` mounts one `ExpandedNodePanel` beside or instead of the Canvas.
- `chatStore` exposes one globally current thread even though messages, drafts, and loading flags are already indexed by `threadId`.
- `canvasStore.expandedNodeId` exposes one globally current expanded node.
- Question-node, Canvas search, World reference, conflict recovery, and ordinary node-open entry points update these stores through different action sequences.

This structure cannot represent multiple open previews, and rendering two Chat panels would make them compete for the same globally current thread, binding, attachments, and session metadata.

`previewStore` used to be a third, generic single-preview path. It had no production `openPreview` caller, so its state was unreachable; it was deleted ahead of this proposal along with the dead branches it fed in `CenterArea`, `Canvas`, `CanvasSearchResults`, `CanvasFloatingPopover`, `FloatingDragHandle`, and `ExpandedNodePanel`.

## 3. Goals

1. Present node previews and unbound chats in one right-side workspace.
2. Allow every tab group to contain multiple tabs.
3. Allow the workspace to show either one tab group or two horizontal tab groups.
4. Treat a Question node as a node-backed Chat preview rather than a separate Chat view.
5. Allow chats that have no Question-node owner.
6. Reopening an already-open node should activate its existing tab and group by default.
7. Allow an explicit Open to Side action to move a target into the other group without duplicating it.
8. Allow independent Chat sessions to remain visible and interactive in both groups without state leakage.
9. Preserve the existing World presentation-anchor and conversation-owner distinction.
10. Reuse the existing node preview renderers, Chat thread caches, agent runtime, and Canvas resize compensation.
11. Keep browsing bounded through transient-tab reuse without silently closing permanent tabs.

## 4. Non-goals

- This proposal does not add a new agent runtime, thread protocol, or server endpoint.
- This proposal does not make every node type editable in preview.
- This proposal does not introduce arbitrary nested splits in the first version.
- This proposal does not make tabs part of shared Canvas state or synchronize workspace layout between users.
- This proposal does not change conversation ownership or copy source-owned World conversations into World references.
- This proposal does not keep the old Expanded Node `replace` / `split` setting as a second meaning of split alongside workspace groups.
- This proposal does not expose tab limits, transient-tab behavior, or split layout as user settings.

## 5. Terminology

| Term                | Meaning                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| Preview Workspace   | The collapsible and resizable right-side surface containing all preview groups.         |
| Preview Group       | One column with a tab strip, one active tab, and one rendered target.                   |
| Preview Tab         | A UI instance identified by `tab.id` and pointing to one `target`.                      |
| Transient Tab       | A tab opened for inspection that the next transient open in its group reuses.           |
| Preview Target      | The business resource rendered by a tab: a Canvas node or an unbound Chat thread.       |
| Node-backed Chat    | The Chat renderer selected for a Question-node target.                                  |
| Unbound Chat        | A Chat thread that has no Question-node owner.                                          |
| Presentation anchor | The node shown in the active Canvas, including a World `nodeRef`.                       |
| Conversation owner  | The source Canvas, Question node, and thread that own conversation state and mutations. |

## 6. State model

The persisted workspace model stores the target itself as the sole resource identity source. It must not store a second `resourceKey` derived from the same fields because duplicated identity state can drift.

```ts
type PreviewTarget =
  | {
      kind: 'node';
      canvasId: string;
      nodeId: string;
    }
  | {
      kind: 'chat';
      canvasId: string;
      threadId: string;
    };

type PreviewTab = {
  id: string;
  target: PreviewTarget;
  /** Reusable inspection slot; see §9.2. */
  transient: boolean;
  /** Activation stamp used to restore recent-target ordering. */
  lastActiveSeq: number;
};

type PreviewGroup = {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
};

type CanvasPreviewWorkspace = {
  tabs: Record<string, PreviewTab>;
  groups: PreviewGroup[];
  activeGroupId: string;
  splitRatio: number;
  /** Source for `lastActiveSeq`, kept in state so ordering is deterministic. */
  activationSeq: number;
};
```

Recency is a counter carried in the workspace rather than a wall-clock timestamp, so recent-target ordering is reproducible in tests and survives serialization without depending on the device clock.

`PreviewTab.id` identifies a UI instance for focus, ordering, drag-and-drop, and close operations. The first version enforces one tab per semantic target across the entire workspace; duplicate target instances are out of scope.

That makes `tab.id` redundant with the target in the first version, which is a deliberate trade. It is kept as the extension point for opening the same node twice (for example the same Note side by side against itself) without a later migration of every persisted layout. The cost is two identifiers for one resource, so the rule is explicit: `isSamePreviewTarget` is the only authority on resource identity, and no code may compare `tab.id` values to decide whether two tabs show the same thing.

Target equality is semantic and centralized. The implementation may derive a string key as an ephemeral `Map` index if profiling demonstrates a need, but that key is not stored or persisted.

```ts
function isSamePreviewTarget(
  left: PreviewTarget,
  right: PreviewTarget,
): boolean {
  if (left.kind !== right.kind || left.canvasId !== right.canvasId) {
    return false;
  }

  if (left.kind === 'node' && right.kind === 'node') {
    return left.nodeId === right.nodeId;
  }

  return (
    left.kind === 'chat' &&
    right.kind === 'chat' &&
    left.threadId === right.threadId
  );
}
```

## 7. Target resolution and rendering

`PreviewRenderer` resolves a target at render time instead of copying mutable node data into the tab.

For a `node` target, the renderer resolves the presentation node from `{ canvasId, nodeId }` and dispatches by its current node type through the existing `NodePreviews` registry. A Question node dispatches to the Chat renderer and derives its `AgentConversationView` from the current node or World reference data.

For a `chat` target, the renderer opens the specified unbound thread in its Canvas scope without fabricating a node ID or `AgentConversationView`.

A World `nodeRef` target remains identified by the World presentation anchor. Its Question renderer resolves the source conversation owner through the existing owner-aware helpers, so history, streams, lifecycle writes, tools, and change records continue to use the source owner.

## 8. Open and focus semantics

All user-visible open paths must converge on one workspace action instead of separately mutating Chat, panel, Canvas, and preview stores.

```ts
openPreviewTarget(
  target: PreviewTarget,
  options?: {
    groupId?: string;
    openToSide?: boolean;
    focus?: boolean;
  },
): string;
```

The default operation searches every group for a tab whose target is equal according to `isSamePreviewTarget`. If found, it activates that tab, focuses its group, opens the workspace, and does not create another tab. Revealing does not relocate the tab; only Open to Side moves one.

Double-clicking an already-open node therefore returns to its existing tab even when that tab is in the other group.

This reveal-across-groups behavior can move focus out from under the user when the target happens to be open in the other group. The first version accepts that in exchange for the guarantee that one resource has one tab. Making reveal conditional — for example only revealing within the focused group and otherwise opening locally — is a deliberate follow-up once the tab model is proven.

Open to Side creates or uses the second group and moves the target's existing tab there. If the target is not open, it creates one tab in the other group. It never creates a duplicate target instance in the first version.

Creating a new unbound Chat mints a new `threadId`, creates a `chat` target, and opens it as a new tab. Returning to an existing unbound Chat uses its existing `{ canvasId, threadId }` target.

Opening an empty workspace lazily creates one unbound Chat; merely loading a Canvas does not. New Chat always mints a new thread and tab. Closing a Chat tab closes only its presentation and does not delete server history or stop a running turn. If every tab is closed, reopening the workspace lazily creates another unbound Chat.

Saving an unbound Chat as a Question node reuses its existing `threadId`. Only after node creation succeeds does the workspace replace the active tab's target in place with the new node target, preserving the tab ID, group position, focus, messages, and draft continuity. A failed node creation leaves the unbound Chat tab unchanged.

## 9. Tabs and groups

The first version supports at most two horizontal groups. This meets the dual-column requirement while avoiding an arbitrary recursive layout tree before interaction and persistence semantics are proven.

Each group has its own active tab. Switching the active tab in one group does not affect the other group.

Tabs can be reordered within a group and moved between groups. Moving the final tab out of a group removes that group and expands the remaining group to the full workspace width.

Closing the active tab activates the nearest remaining tab in the same group. Closing the last workspace tab collapses the workspace but does not stop any running agent turn.

The group separator is keyboard-accessible and pointer-resizable. The ratio is clamped so both groups retain a useful minimum width.

Each group mounts only its active tab panel. Inactive tabs retain their model and runtime state in stores but do not retain editor, PDF, media, or Chat component trees. Running Chat streams continue writing to their thread state while their tab is inactive. Switching away from an editable Note or Text tab first runs its settle boundary; view-state restoration such as scroll and cursor position may be added independently without keeping inactive renderers mounted.

Splitting is unavailable when the workspace cannot satisfy the minimum width of both groups. If a restored two-group layout no longer fits, the UI presents it as one group until sufficient width is available without deleting either group's tabs.

### 9.1 Tab presentation and naming

A tab's title is derived at render time from its target, never copied into the tab:

- A `node` target shows the node's current `label`. An empty label falls back to the existing `node.untitled` string, matching the Expanded Node header today.
- A `chat` target shows a generic Chat label until it is saved as a Question node, at which point the in-place target conversion of §8 makes it a `node` target and the node label takes over.
- Renames propagate live, because the title is read from the node rather than stored on the tab.

Titles are single-line, middle-of-string truncated with the full label in the accessible name and a tooltip. Two tabs may legitimately show the same label; the first version does not attempt VS Code's path-based disambiguation, so the accessible name additionally carries the node type to keep screen-reader output distinguishable.

### 9.2 Bounding open tabs

Without a bound, double-clicking through a Canvas produces an unusable tab strip. Two independent mechanisms apply, mirroring the editor model.

A **transient tab** is the primary defence. Opening a target for inspection reuses the group's existing transient tab instead of appending a new one, so browsing many nodes never grows the strip beyond one tab. The tab is rendered in italics and is promoted to a permanent tab by editing its content, double-clicking the tab, or using Pin. Open to Side moves the tab while preserving whether it is transient or permanent. Which entry points open transiently is deliberately narrow: Canvas search results and connected-node navigation open transiently, while Question compose, Question replay, New Chat, and explicit node open are permanent.

Permanent tabs are never closed automatically. The transient inspection slot remains the browsing backstop, while explicitly opened or promoted tabs stay available until the user closes them or their target node is deleted.

## 10. Chat session isolation

Two groups may mount two Chat renderers simultaneously, so Chat UI and hooks must address an explicit `threadId` rather than reading one globally current thread.

### 10.1 Single-session leak inventory

The migration is not a data-structure tidy-up. Chat state is now one `ChatThreadState` per thread and every renderer addresses its own `ChatSession`, but the rows still open below are singletons that two mounted renderers would fight over. Each must be resolved before Stage 3 mounts a second Chat.

| #   | Leak                                                                                                                                                                            | Location                                                                                                                                 | Resolution                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | ~~`threadId` is the globally current thread, and `ChatPanel` reads it to decide which session to build~~                                                                        | [`chatStore.ts`](../../apps/web/src/store/chatStore.ts)                                                                                  | **Done.** `ChatPanel` requires a tab-supplied session; `chatStore` has no globally current thread. Canvas chat identity is only the persisted `threadMap` seed.                  |
| L2  | ~~`binding`, `settings`, and compose `lastAction` can leak between sessions~~                                                                                                   | [`chatStore.ts`](../../apps/web/src/store/chatStore.ts)                                                                                  | **Done.** All three live on `ChatThreadState`; a bounded thread-keyed projection preserves compose mode across refresh, while authored Question mode remains node-authoritative. |
| L3  | ~~`pendingAttachments` and `selectionAttachment` are one global staging slot~~                                                                                                  | [`chatStore.ts`](../../apps/web/src/store/chatStore.ts), [`ChatInput.tsx`](../../apps/web/src/components/Panels/ChatPanel/ChatInput.tsx) | **Done.** `pendingAttachments` is thread-local. The excerpt stays deliberately shared and single: one selection, spent by whichever Chat sends.                                  |
| L4  | ~~Question presentation used a global `viewingQuestionThread`, replay map, open position, and Canvas save/restore stack~~                                                       | [`chatStore.ts`](../../apps/web/src/store/chatStore.ts)                                                                                  | **Done.** Tabs own targets and sessions; the pointer, replay map, `_savedCanvas*` stack, and legacy open/close actions were deleted.                                             |
| L5  | ~~`useAgentStream()` takes no arguments and reads the global `threadId`~~                                                                                                       | [`useAgentStream.ts`](../../apps/web/src/hooks/useAgentStream.ts)                                                                        | **Done.** Takes a `ChatSession`; `stopStream` aborts its own session's run.                                                                                                      |
| L6  | ~~`useChatHistory(setIsLoading)` reads the global `threadId` and calls `switchToCanvas` as a side effect~~                                                                      | [`useChatHistory.ts`](../../apps/web/src/hooks/useChatHistory.ts)                                                                        | **Done.** Takes a `ChatSession`; the Canvas switch moved to `ChatPanel`.                                                                                                         |
| L7  | ~~`ChatPanel` feeds hooks and descendants the global `threadId`~~                                                                                                               | [`ChatPanel/index.tsx`](../../apps/web/src/components/Panels/ChatPanel/index.tsx)                                                        | **Done.** `ChatPanel` builds one `ChatSession` and provides it via context; every descendant reads that.                                                                         |
| L8  | ~~`intentStore._setOnIntentChosen` is a single callback slot registered by `ChatPanel`~~                                                                                        | —                                                                                                                                        | **Resolved by deletion.** The intent recogniser and sketch gesture recognition were removed; no callback slot remains.                                                           |
| L9  | ~~`panelStore.focusChatInputNonce` is one global nonce, so a focus request cannot address a specific group~~                                                                    | [`panelStore.ts`](../../apps/web/src/store/panelStore.ts)                                                                                | **Done.** The request carries a thread id; a composer takes focus only when the request names its own session. Retarget to a tab or group in §8.                                 |
| L10 | ~~`ExpandedNodePanel` installs window-level `keydown` (Escape, upstream/downstream navigation) and `document`-level `selectionchange` listeners that assume a single instance~~ | [`ExpandedNodePanel.tsx`](../../apps/web/src/components/Panels/ExpandedNodePanel/ExpandedNodePanel.tsx)                                  | **Done.** Window-level shortcuts run only in the focused group; selection tracking was already scoped to the panel element.                                                      |

`AcpSessionSelectors` already uses React `useId()`, and `useAgentStream`'s `AbortController` registry is already keyed by `threadId`; neither needs work.

### 10.2 Normalized thread state

The Chat store is normalized around one complete object per thread instead of parallel maps that can drift independently:

```ts
type ChatThreadState = {
  messages: ChatMessage[];
  draft: string;
  historyStatus: 'idle' | 'loading' | 'loaded' | 'error';
  isStreaming: boolean;
  binding: AgentBinding;
  lastAction: AgentMode;
  settings: ChatSessionSettings;
  pendingAttachments: ChatAttachment[];
};

type ChatState = {
  threadsById: Record<string, ChatThreadState>;
};
```

Thread creation, migration, eviction, and deletion create or remove one complete `threadsById[threadId]` entry atomically. Actions take `threadId` explicitly and update that entry immutably. Components subscribe to the narrow field they render rather than selecting the complete `threadsById` map.

Messages, drafts, history status, streaming status, binding choices, session settings, and explicit attachments belong to the thread object. An in-flight `AbortController` and other non-serializable runtime handles remain in a module-level registry keyed by `threadId`.

Question-node status, owner identity, bound `agentMode`, and other node business fields remain authoritative on the node and are not copied into `ChatThreadState`. Before a Question node's first send, its thread object carries the mutable compose choices; the successful first send writes the selected binding and mode onto the node, after which the node values take precedence when deriving the effective session.

Canvas node selection and Preview text selection are shared ephemeral context, not per-thread state. There is only one browser selection, so every visible Chat may display the same hint. On send, the submitting session snapshots the then-current selection into that request and spends it: the hint retires from every Chat, because that one selection has now been used. Without a send, selection changes remain UI-only and are not written into any thread. Because focusing a composer can collapse the browser selection, Preview text selection is retained in one transient `selectionContext` until it is spent by a send, or the originating selection changes or becomes invalid. User-added files, captures, and other explicit attachments remain in the submitting thread's `pendingAttachments`.

Question presentation and conversation-owner descriptors belong to the Preview target/renderer boundary rather than the Chat thread object. Open position and focus requests are addressed to a tab or group, not stored as globally current Chat state.

`useAgentStream`, `useChatHistory`, `useAcpSessionMeta`, `useBuiltinThreadSettings`, and submission handlers must capture the explicit owner thread and Canvas scope. No renderer may change another group's visible session by updating a global current-thread pointer.

Changing or closing a tab is presentation navigation only. Running streams continue through their existing per-thread ownership and can update cached messages while their tab is inactive or closed.

## 11. Canvas layout integration

`MainLayout` continues to own the left panel, centre Canvas, right workspace width, collapse state, and outer resize handle. Its right child becomes `PreviewWorkspace` instead of `ChatPanel`.

`CenterArea` stops owning `ExpandedNodePanel` and always hosts the mounted Canvas. The old Expanded Node `replace` / `split` mode is retired so it cannot conflict with the new meaning of a split Preview Workspace.

Opening the workspace from a node carries that node as a one-shot layout anchor. The existing Canvas centre compensation and minimum reveal behavior are generalized from Chat and Expanded Node state to the unified workspace.

The workspace's outer maximum width must allow two useful groups while preserving a minimum Canvas width. It should be constrained from the available width rather than retaining the current fixed 50% right-panel maximum.

### 11.1 canvasStore ownership boundary

`canvasStore` owns the document and its command pipeline. The workspace owns what is on screen. Today those two concerns are mixed, so the migration has to say for each field whether it moves, dies, or stays.

| Current state                                   | Fate                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `expandedNodeId`                                | **Done.** Moved. Deleted from `canvasStore`; readers derive the shown node from the workspace's active tab.                                 |
| `expandMode`, `setExpandMode`                   | **Done.** Died with the retired replace / split mode.                                                                                       |
| `expandedNodeFocusTick`                         | **Done.** Replaced by a runtime-only, one-shot `{ tabId, nonce }` request that is consumed after the addressed tab focuses.                 |
| `openExpanded`, `closeExpanded`                 | **Done.** Replaced by `openPreviewTarget` and tab close, which still invoke the settle boundary.                                            |
| `settleNodePreprocess`                          | Stays. Preprocessing is document work; the workspace calls into it at the settle boundary.                                                  |
| `nodes`, `edges`, `updateNodeData`, `tryRename` | Stay. A renderer reading node data from `canvasStore` is reading the document, not presentation.                                            |
| `UiIntentResult.expandedNodeId`                 | **Done.** Moved. Renamed `openPreviewNode`; the intent carries a preview request instead of bypassing the pipeline with a direct state set. |

Retiring `expandMode` removes the "the Canvas is not visible" condition entirely, because the workspace's maximum width always preserves a minimum Canvas width. Four call sites lose their guard rather than gaining a new one:

- `CanvasFloatingPopover`'s `hiddenByExpandedPanel` is deleted. Its sibling `canvasAttentionStore.isCanvasEngaged` check already expresses the real intent — the user's attention is on another surface — without inferring it from a layout mode.
- `FloatingDragHandle`'s `isFullscreen` fallback is deleted; drag to Canvas is always available.
- `ExpandedNodePanel`'s full-view / split-view toggle is deleted along with the panel itself.
- `Canvas`'s reveal anchor stops testing `expandMode === 'split'` and reads the workspace's active tab target, per the generalization above.

## 12. Persistence and lifecycle

Workspace topology is local UI state and is stored per Canvas in versioned local storage. Persisted fields are tabs, targets, groups, active IDs, split ratio, outer width, and collapsed state. Refresh restores all open tabs and both groups, while only each group's active tab is mounted.

Messages, drafts, stream controllers, loaded-history flags, permission state, node snapshots, and resolved World owner data are not duplicated into workspace persistence.

### 12.1 Bounding persisted layout

Per-Canvas layout accumulates without bound unless it is explicitly managed. The approach follows the editor model, which solves the same problem:

- **Namespace per Canvas, one record each.** Keys follow the existing `huabu.<feature>.<canvasId>` convention already used by the viewport record, rather than one growing blob under a single key. A Canvas that is never reopened costs one small record and is never read.
- **Store identity, never content.** A tab persists only its target descriptor. This is why the editor can restore hundreds of tabs cheaply: each one serializes to a type tag plus a resource reference, and any entry that fails to deserialize is silently dropped on restore rather than blocking the rest.
- **Keep browsing bounded without closing permanent tabs.** The transient slot of §9.2 prevents search and connected-node navigation from appending a tab per inspected target. Explicitly retained tabs remain in the per-Canvas record until the user closes them.
- **Write on unload, not per mutation.** Layout is flushed when the page unloads or the Canvas is left, matching the editor's save-on-will-shutdown behavior, so tab switching never touches storage.
- **Delete on Canvas delete.** Deleting a Canvas deletes its layout record in the same operation. This is the only deterministic reclamation path; do not rely on age-based expiry for records the user can still reach.
- **Cap the index, not the records.** A separate MRU list of Canvas IDs with a fixed maximum bounds total growth. When a Canvas falls off the end of the list its layout record is deleted, and reopening that Canvas simply starts from the default single-group layout. Losing tab layout for a long-untouched Canvas is a non-destructive outcome, because no content lives in the record.

### 12.2 Validation and node lifecycle

After a Canvas loads, target validation removes tabs for deleted local nodes and repairs missing active IDs or empty groups. World reference targets are validated against the current resolved reference projection and display an explicit unavailable state while resolution is transient.

Deleting a Question node closes every tab targeting that presentation node but does not cancel an already-running server turn. Existing thread-history retention rules continue to decide whether its history remains available outside the Canvas UI.

A node deleted elsewhere while its tab holds unsettled editable content runs that tab's settle boundary before the tab is removed, so the existing `settleNodePreprocess` contract is not bypassed by a remote deletion.

Closing or switching away from an editable Note or Text preview must preserve the current `settleNodePreprocess` boundary owned by `openExpanded` and `closeExpanded`.

The persisted workspace schema carries a version and migration function. The initial migration seeds one unbound Canvas Chat tab from an existing `threadMap` entry when no newer workspace state exists; a legacy `questionReplayByCanvas` entry maps to a Question-node target. After migration, `threadMap` has no special "main Chat" role and is retired when all callers use workspace targets and `threadsById`.

## 13. Component boundaries

The workspace owns tab chrome, group focus, close controls, split controls, drag-and-drop, empty state, and outer collapse behavior.

The existing `ChatPanel` is decomposed into a session-scoped `ChatPreview` renderer without a `SidebarPanel` shell. The existing `ExpandedNodePanel` is decomposed into a `NodePreviewPane` that retains node-specific actions, rename, connected-node navigation, read-only behavior, preview search, and `NodePreviewContent`.

Question-node and unbound-chat targets share `ChatPreview`; their session descriptors differ, but the message list, composer, permissions, selectors, change review, and agent controls are common.

Workspace-specific tab components remain colocated under the Preview Workspace feature. Existing `Button`, `Input`, `DropdownMenu`, tooltip, token, and icon primitives remain mandatory; the segmented `TabGroup` control is not suitable for a reorderable editor tab strip.

## 14. Accessibility and keyboard behavior

With two groups mounted, every keyboard handler must belong to exactly one group. The rule is that only the focused group responds: a handler either lives on the group's DOM subtree, or it is a window-level handler guarded by "this group is the active group". Handlers that today assume a single panel instance — the Expanded Node Escape key, the upstream and downstream connected-node navigation shortcuts, and the `selectionchange` excerpt listener — move to the focused-group rule as part of L10 in §10.1. Escape closes the active tab of the focused group only.

Each tab strip uses the WAI-ARIA tabs pattern with roving focus, `aria-selected`, `aria-controls`, and labelled tab panels.

Arrow keys move focus among tabs in the current group. Enter or Space activates the focused tab. Delete or the platform close shortcut closes the active tab when focus ownership permits it.

Moving a tab between groups and creating or removing a group must announce the resulting position through an accessible status message. Drag-and-drop has equivalent keyboard commands.

Existing editable controls, preview search, menus, media viewers, and Canvas shortcuts retain their current keyboard ownership.

## 15. Implementation sequence

Every stage below is independently shippable. A stage may land as more than one pull request, but no pull request may leave two live sources of truth for the same state across a stage boundary.

### Stage 0: Ground clearing (shipped)

- Delete `previewStore` and the unreachable branches it fed. Landed ahead of this proposal; the state was unreachable because nothing called `openPreview`.
- Add characterization tests for `chatStore` covering per-thread caches, the global singletons that Stage 2 will move, `switchToCanvas`, `clearMessages`, the Question open/close round trip, node-deletion rollback, and thread eviction. These are the regression net Stage 2 refactors against, and they must keep passing unchanged wherever the behavior is intended to survive.

### Stage 1: Workspace model (shipped)

- Add the target, tab, and group model with semantic target equality as pure reducers: no React, no store binding, no storage.
- Add the per-Canvas persistence layer with a versioned record, repair-on-read, a capped Canvas index, and the seed from pre-workspace Chat state.
- Cover open, global target uniqueness, reveal without relocation, reorder, move, Open to Side, split, merge, close, transient-tab reuse, permanent-tab retention, validation, defensive parsing, and index capping.

The zustand binding and the compatibility adapters for the existing single-panel actions are deliberately **not** part of this stage. Bound to nothing, they would sit unused through all of Stage 2 while still having to be kept correct against two moving targets. They land in Stage 3 with their first real consumer. The pure model is not idle in the same way: it is a fully tested library that Stage 3 assembles rather than code waiting for a caller.

### Stage 2: Session-scoped Chat (shipped)

- Resolve L1 through L9 of §10.1, migrating parallel per-thread maps and singleton Chat presentation fields into complete `threadsById[threadId]` objects plus explicit session descriptors.
- Add one shared transient `selectionContext` and snapshot it only in the submitting session's send path.
- Refactor Chat hooks and renderer internals to use that descriptor.
- Prove two simultaneously mounted Chat renderers have independent messages, drafts, bindings, attachments, history loading, permissions, and stream controls.

**Correction, found while implementing.** L1 and L4 cannot land in this stage, and the ordering above was wrong to put them here.

The `_savedCanvas*` save/restore stack and the globally current `threadId` existed for one reason: a single panel had to stash the Canvas conversation before showing a Question one. Once a tab owned its target, there was nothing to stash, so Stage 5 deleted both after entry-point migration completed.

Everything else in this stage is done: L2, L3, L5, L6, L7, L8 by deletion, and L9. L2's final compose-mode field landed during Stage 3 once `QuestionNode` and each mounted `ChatPanel` could address an explicit thread.

The acceptance criterion split the same way while Stage 2 was landing. [`chatSessionIsolation.test.tsx`](../../apps/web/src/hooks/chatSessionIsolation.test.tsx) mounts two real `ChatPanel`s under different sessions and proves their conversations and compose modes remain independent.

### Stage 3: Workspace UI (shipped)

- **Done.** Bind the Stage 1 model into a zustand store and add the compatibility adapters for the existing single-panel actions. The adapters are one-directional: the workspace store is authoritative and the legacy actions delegate to it. Nothing writes back into `canvasStore`, so there is never a second source of truth.
- **Done.** Retire `expandMode` and the four guards that depended on it, per §11.1.
- **Done.** Build the tab strip, group, renderer dispatch, split handle, drag-and-drop reordering, empty state, transient-tab affordance, and accessibility behavior. Pointer and keyboard drag sensors resolve a tab or group drop target to the Stage 1 `moveTab` action, so same-group ordering, cross-group movement, and empty-source-group removal retain one topology authority.
- **Done.** Resolve L1 and L4: `ChatPanel` requires a session, a tab supplies one from its own target, and the two-`ChatPanel` case in [`chatSessionIsolation.test.tsx`](../../apps/web/src/hooks/chatSessionIsolation.test.tsx) proves isolation.
- **Done.** Resolve L10 of §10.1 by scoping window-level keyboard handlers to the focused group; the existing selection handler was already panel-scoped.
- **Done.** Resolve the `lastAction` remainder of L2: each mounted Chat and composing Question reads and writes its explicit thread's mode.
- **Done.** Mount only the active tab in each group and settle editable Note/Text content before switching or closing.
- **Done by reuse.** Keep `ChatPanel` as the canonical embedded conversation renderer and dispatch node renderers through `PreviewRenderer`; separate `ChatPreview` and `NodePreviewPane` wrappers would only rename existing boundaries.
- **Done.** Mount the workspace in `MainLayout`, keep `CenterArea` Canvas-only, seed the Canvas's canonical Chat when needed, and collapse the outer panel when its final tab closes. Stage 5 removed the rollback flag and legacy panel paths.

**Correction, found while implementing.** `canvasStore.expandedNodeId` did not survive to Stage 5 as planned. Keeping it while the workspace also tracked the shown node would have been exactly the second source of truth the first item forbids, so it was deleted as part of the adapter change and every reader now derives the node from the workspace's active tab. The `UiIntentResolution.expandedNodeId` retarget listed under Stage 4 moved with it, for the same reason and at no extra cost: the field had one producer and one consumer.

Opening also classifies transient versus permanent per §9.2 already, rather than in Stage 4. The `openExpanded` call sites were all being touched anyway, and labelling them uniformly would only have had to be undone.

L1 and L4 also split rather than landing whole. A tab now supplies the session, which is the part that made two Chat renderers possible, but the store-wide `threadId` and the `_savedCanvas*` stack cannot be deleted while the flag-off path still renders the single panel through them. Their removal moves to Stage 5, alongside the fallback they serve.

### Stage 4: Entry-point migration (shipped)

- Route ordinary node double-click, Question compose/replay, Canvas search, World references, conflict recovery, connected-node navigation, post-create editing, and New Chat through `openPreviewTarget` directly, rather than through the `openExpanded` adapter.
- Generalize Canvas resize anchoring and floating-control attention from Chat/Expanded-specific state to workspace state.
- Implement Save Chat as Question as an in-place target conversion.

### Stage 5: Legacy removal (shipped)

- **Done.** Remove the store-wide `threadId`, `_savedCanvas*` restore stack, replay map, and legacy Question presentation actions (L1 / L4).
- **Done.** Remove the single-panel Chat fallback, centre-area Expanded Node layout, feature flag, and Settings toggle.
- **Done.** Fold the shipped behavior into `web-architecture.md` and `question-node.md` and mark this proposal Shipped.

### Rollout and rollback

Stages 1 and 2 shipped without user-visible changes. Stage 3 introduced the workspace behind a rollback flag, Stage 4 migrated all entry points, and Stage 5 removed the flag and legacy presentation paths after focused migration coverage passed.

### Effort

Roughly 35 to 55 files and 5,000 to 8,000 lines of production change plus 1,500 to 3,000 lines of tests. The `ChatPanel` subtree alone is 20 files with a 1,045-line entry component, `chatStore` is 1,080 lines with 25 actions, `ExpandedNodePanel` is about 737 lines, and at least nine distinct `openExpanded` entry points need rerouting. Stage 2 carries most of the risk and produces no user-visible change, which is why Stage 0's characterization tests are a prerequisite rather than a nicety.

## 16. Verification

Store tests must cover semantic equality without a stored `resourceKey`, global target uniqueness, repeat-open focus across groups, Open to Side movement, transient-tab reuse and promotion, permanent-tab retention, atomic thread creation/eviction, active-tab fallback, group removal, node deletion, Canvas switching, layout-record deletion on Canvas delete, Canvas-index capping, and persisted-state migration.

Component tests must cover tab keyboard behavior, accessible names and relationships, title derivation and truncation for labelled, unlabelled, and unbound-chat targets, pointer and keyboard tab movement, split resizing, and renderer dispatch for ordinary nodes, Question nodes, World Question references, and unbound chats.

Integration tests must mount two Chat previews at once and prove that composing, sending, stopping, changing agent settings, resolving permission, and receiving stream events in one thread do not mutate the other visible thread. Selection-context tests must prove that both Chats can display the current hint while only the sender snapshots it, and that explicit attachments remain thread-local.

Regression tests must preserve Note/Text settle-on-switch/close behavior, active-only renderer mounting, in-preview search, connected-node navigation, Canvas viewport compensation, question unread/viewed transitions, World conversation ownership, unbound-Chat-to-Question failure rollback, and running-thread continuity after tab close. The Stage 0 `chatStore` characterization tests must keep passing through Stage 2 wherever the behavior is intended to survive; any test that has to change is a behavior change and needs an explicit note in its pull request.

Beyond correctness, Stage 3 must confirm that mounting two renderers alongside the Canvas does not regress Canvas interaction frame rate, and that switching the active tab in a group stays perceptually immediate. These are gate conditions for the flag flip, measured on a Canvas at the upper end of the sizes the app already supports.

Before review, run the focused web tests for the touched stores and components, followed by repository `pnpm typecheck`, `pnpm format`, and `pnpm lint:fix` as required by the repository workflow.

## 17. Code entry points

| File/dir                                                                                                             | Current responsibility and migration role                                                    |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`apps/web/src/pages/CanvasPage/MainLayout.tsx`](../../apps/web/src/pages/CanvasPage/MainLayout.tsx)                 | Owns the outer right column and mounts the unified workspace.                                |
| [`apps/web/src/pages/CanvasPage/CenterArea.tsx`](../../apps/web/src/pages/CanvasPage/CenterArea.tsx)                 | Owns Canvas-only presentation and the floating workspace entry controls.                     |
| [`apps/web/src/components/Panels/ChatPanel/`](../../apps/web/src/components/Panels/ChatPanel)                        | Existing conversation UI to extract into a session-scoped renderer.                          |
| [`apps/web/src/components/Panels/ExpandedNodePanel/`](../../apps/web/src/components/Panels/ExpandedNodePanel)        | Existing node-preview behavior to extract into a workspace pane.                             |
| [`apps/web/src/components/Nodes/NodePreviewContent.tsx`](../../apps/web/src/components/Nodes/NodePreviewContent.tsx) | Existing node-type renderer dispatch reused by node targets.                                 |
| [`apps/web/src/store/chatStore.ts`](../../apps/web/src/store/chatStore.ts)                                           | Existing per-thread caches plus singleton presentation state to normalize.                   |
| [`apps/web/src/store/canvasStore.ts`](../../apps/web/src/store/canvasStore.ts)                                       | Owns the legacy single expanded-node state and Note/Text settle behavior.                    |
| [`apps/web/src/store/conversationOwner.ts`](../../apps/web/src/store/conversationOwner.ts)                           | Existing presentation-anchor and conversation-owner resolution reused by Question renderers. |
| [`apps/web/src/store/panelStore.ts`](../../apps/web/src/store/panelStore.ts)                                         | Existing panel collapse, focus, and layout-anchor state to generalize (L9).                  |
