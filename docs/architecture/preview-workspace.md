# Preview Workspace

Preview Workspace is the only right-side presentation surface on a Canvas page. It hosts node previews and unbound Chat conversations in one or two tab groups while the Canvas remains mounted in the centre.

The implementation originated in the [Unified Preview Workspace proposal](../proposals/unified-preview-workspace.md). This document is authoritative for the shipped system; the proposal is retained as design and migration history.

## 1. Ownership boundaries

Preview Workspace owns presentation topology: open tabs, tab order, active tabs, groups, split ratio, transient inspection state, and runtime requests addressed to a tab.

`canvasStore` owns Canvas document state and the command pipeline. Preview renderers read live nodes from that store rather than copying node content or labels into tabs.

`chatStore` owns conversation state keyed by `threadId`: messages, drafts, history status, streaming state, binding, model settings, compose mode, and pending attachments. Preview Workspace stores only the target needed to select a renderer.

`panelStore` owns and persists the outer right-column collapse state and owns thread-addressed composer focus requests. Opening a Preview target expands the right column; closing a tab does not delete its underlying node or conversation history. `MainLayout` treats the persisted collapse state as authoritative whenever no panel motion is active. A settled collapsed slot is zero-width and clips overflow, while an active open/close motion temporarily releases that clipping; interrupted startup hydration therefore cannot leave translated panel content visible over the Canvas in either persisted state.

```text
Canvas command -> canvasStore document -> Preview target resolves live node
User open     -> Preview Workspace  -> active tab/group
Chat renderer -> chatStore thread   -> messages, binding, stream state
Outer layout  -> panelStore         -> collapsed/open and composer focus
```

## 2. Persisted model

A workspace is scoped to one Canvas and contains semantic targets rather than renderer snapshots.

```ts
type PreviewTarget =
  | { kind: 'node'; canvasId: string; nodeId: string }
  | { kind: 'chat'; canvasId: string; threadId: string };

type PreviewTab = {
  id: string;
  target: PreviewTarget;
  transient: boolean;
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
  activationSeq: number;
};
```

`tab.id` is presentation identity. `isSamePreviewTarget` is the only authority for resource identity: node targets compare `{ canvasId, nodeId }`, and Chat targets compare `{ canvasId, threadId }`.

The first shipped model allows at most one tab for a semantic target across the workspace. Reopening a target activates its existing tab even when it belongs to the other group.

Titles are derived at render time. Node tabs use the current node label; Chat tabs derive their conversation label. Renaming a node therefore updates its tab without mutating workspace state.

## 3. Opening and target conversion

`openPreviewTarget` is the topology action. It opens or activates a target in the focused group, supports transient inspection, and delegates all ordering and group repair to the pure model.

`openPreviewNode` is the user-facing node adapter. It settles the previously active editable Note or Text when necessary, expands the right panel, opens the node target, and requests editor focus for an explicitly opened Note.

`openChat` activates the most recently used unbound Chat target or creates a new thread and tab when none exists. New conversation always creates an independent `threadId`.

Open to Side moves the existing semantic target into the other group instead of duplicating it. Saving an unbound Chat as a Question replaces that tab's target in place, preserving tab identity, position, messages, and draft continuity.

Canvas search results and connected-node navigation open transiently. Explicit node opens, Question compose or replay, and new Chat opens are permanent.

## 4. Rendering and Chat sessions

Each group mounts only its active tab. Inactive tabs retain topology and store-backed runtime state but do not retain editor, PDF, media, or Chat component trees.

`PreviewRenderer` resolves node targets against the current Canvas nodes and World references. Ordinary nodes render through `ExpandedNodePanel`; Question nodes and unbound Chat targets render through `ChatPanel`.

Every mounted `ChatPanel` receives an explicit `ChatSession` and owning preview tab ID. There is no globally current Chat thread or Question replay pointer, so two groups can render independent conversations without sharing messages, drafts, bindings, attachments, settings, loading state, or stream control.

For a World `nodeRef` that presents a source Question, the target remains the World presentation node while `AgentConversationView` carries the source Canvas, node, and thread as conversation owner. History, reconnect, agent turns, tools, lifecycle writes, binding, mode, and change records use that owner scope.

An authored Question node remains authoritative for persisted agent mode and fixed binding. A new selectable Question thread inherits the Canvas's current binding unless the node supplies an explicit binding.

## 5. Groups, tabs, and bounds

The workspace contains one or two horizontal groups. Each group owns one active tab, and only the active group receives group-scoped keyboard actions.

Tabs can be reordered within a group or moved across groups with pointer or keyboard drag sensors. Every drop delegates to the pure `moveTab` model action, which repairs ordering, active tabs, and empty source groups.

Closing an active tab selects the nearest remaining tab in the same group. Moving or closing the final tab in a secondary group removes that group. The workspace keeps one empty primary group as its valid empty state.

A transient tab is one reusable inspection slot per group. Opening another transient target replaces that slot; double-clicking the tab or committing a persistent mutation through its renderer promotes it in place.

Each group is capped at 12 tabs by deterministic MRU eviction. Active tabs, streaming conversations, and node tabs with unsettled content are protected from eviction.

The activation sequence is an integer stored with the workspace rather than a wall-clock timestamp, making MRU ordering deterministic in tests and persistence.

## 6. Focus and opening position

Editor focus is a runtime-only `{ tabId, nonce }` request. Only the addressed active tab receives it, and its renderer consumes it after focus succeeds so remounting cannot replay stale intent.

Question conversation positioning is a runtime-only `{ tabId, position, nonce }` request where `position` is `last-user` or `bottom`. `MessageList` consumes the request after history hydration and successful positioning.

Inactive tabs never count as actively viewed. A Question is actively viewed only when its tab is the active tab of a rendered group and the outer right panel is expanded; this rule controls the Canvas open indicator and whether stream completion marks a result as viewed.

Composer focus is addressed by `threadId` through `panelStore`, so opening one Chat cannot steal focus through a request intended for another mounted Chat.

## 7. Persistence and validation

Workspace topology is local UI state stored under one versioned local-storage record per Canvas. Content, messages, drafts, stream handles, and resolved node data are not duplicated into that record.

The current Canvas layout is written synchronously before switching Canvas and by the consolidated `beforeunload` handler. Tab switching and ordinary topology mutations do not write storage immediately.

A capped MRU index retains workspace records for at most 50 Canvases. Evicting an old layout is non-destructive because the record contains presentation topology only.

Persisted input is parsed defensively. Invalid targets, dangling tab IDs, duplicate group references, invalid active IDs, excess groups, and malformed split values are dropped or repaired without preventing the remaining layout from loading.

After a command deletes nodes, the web post-effect validates the workspace against the committed live node IDs. Tabs targeting deleted nodes are removed and active IDs or empty groups are repaired by `validateWorkspace`.

Closing a Preview tab does not delete the Canvas node, stop a running turn, or remove server-side Chat history. Persistence exposes `deleteWorkspace(canvasId)`, but Canvas deletion does not currently call it in production; unreachable layout records are reclaimed when they fall out of the capped Canvas MRU index.

## 8. Layout and accessibility

`MainLayout` owns the resizable outer right column and mounts `PreviewWorkspace`; `CenterArea` remains Canvas-only. The outer width preserves usable Canvas space, while the internal split ratio is clamped so both groups remain usable.

The separator exposes a symmetric pointer target around its visible rule, tracks pointer movement on `window`, and supports keyboard resizing.

Each group uses the WAI-ARIA tabs pattern with a tablist, selected tab, labelled tabpanel, and roving keyboard focus. Only the focused group responds to group-level shortcuts; editable controls, search, menus, and media viewers keep ownership of their own keys.

Tab titles are visually truncated while retaining full accessible labels and tooltips. Transient tabs are visually distinct and expose their temporary status and promotion gesture accessibly.

## 9. Integration rules

New user-visible node and Chat open paths must use the Preview Workspace actions rather than independently mutating panel, Canvas, and Chat presentation state.

Renderer code must treat targets as references and resolve mutable data at render time. Adding labels, node snapshots, conversation state, or derived resource keys to persisted tabs creates a second source of truth and is not allowed.

Code that determines visibility must inspect each group's active tab, not every tab in `workspace.tabs`, because inactive tabs are not mounted.

Runtime intents such as editor focus, composer focus, and initial message position must stay outside the persisted workspace model and must be addressed to a tab or thread.

Document mutations remain in the Canvas command path. Preview Workspace may request settling or validation at lifecycle boundaries, but it does not directly author Canvas node content or topology.

## 10. Code entry points

| File/dir                                                                                                                                                 | Responsibility                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`apps/web/src/store/previewWorkspace/model.ts`](../../apps/web/src/store/previewWorkspace/model.ts)                                                     | Pure target, tab, group, move, close, validation, transient, and MRU rules.                          |
| [`apps/web/src/store/previewWorkspace/store.ts`](../../apps/web/src/store/previewWorkspace/store.ts)                                                     | Zustand binding, Canvas load/flush lifecycle, and runtime tab-addressed requests.                    |
| [`apps/web/src/store/previewWorkspace/persistence.ts`](../../apps/web/src/store/previewWorkspace/persistence.ts)                                         | Versioned per-Canvas local-storage records, repair-on-read, migration seed, and capped Canvas index. |
| [`apps/web/src/store/previewWorkspace/actions.ts`](../../apps/web/src/store/previewWorkspace/actions.ts)                                                 | Canonical user-facing node and Chat open adapters.                                                   |
| [`apps/web/src/store/previewWorkspace/protection.ts`](../../apps/web/src/store/previewWorkspace/protection.ts)                                           | Computes tabs protected from MRU eviction.                                                           |
| [`apps/web/src/components/Panels/PreviewWorkspace/`](../../apps/web/src/components/Panels/PreviewWorkspace)                                              | Workspace layout, groups, tab strips, drag-and-drop, split resizing, and target rendering.           |
| [`apps/web/src/components/Panels/ChatPanel/index.tsx`](../../apps/web/src/components/Panels/ChatPanel/index.tsx)                                         | Session-scoped conversation renderer used by Question and unbound Chat targets.                      |
| [`apps/web/src/components/Panels/ExpandedNodePanel/ExpandedNodePanel.tsx`](../../apps/web/src/components/Panels/ExpandedNodePanel/ExpandedNodePanel.tsx) | Embedded ordinary-node preview renderer.                                                             |
| [`apps/web/src/components/Nodes/question/questionCompose.ts`](../../apps/web/src/components/Nodes/question/questionCompose.ts)                           | Question binding initialization, conversation opening, initial position, and compose focus.          |
| [`apps/web/src/hooks/useActivelyViewingQuestion.ts`](../../apps/web/src/hooks/useActivelyViewingQuestion.ts)                                             | Shared active-visible Question semantics for render and stream completion paths.                     |
| [`apps/web/src/handler/canvasCommand/postEffects.web.ts`](../../apps/web/src/handler/canvasCommand/postEffects.web.ts)                                   | Validates Preview targets after committed node deletion.                                             |
| [`apps/web/src/store/canvasStore/save/unloadFlush.ts`](../../apps/web/src/store/canvasStore/save/unloadFlush.ts)                                         | Consolidated page-unload persistence boundary, including workspace layout flush.                     |
