# Preview Workspace

Preview Workspace is the only right-side presentation surface on a Canvas page. It hosts node previews and unbound Chat conversations in one or two tab groups while the Canvas remains mounted in the centre.

The implementation originated in the [Unified Preview Workspace proposal](../proposals/unified-preview-workspace.md). This document is authoritative for the shipped system; the proposal is retained as design and migration history.

## 1. Ownership boundaries

Preview Workspace owns presentation topology: open tabs, tab order, active tabs, groups, split ratio, transient inspection state, and runtime requests addressed to a tab.

`canvasStore` owns Canvas document state and the command pipeline. Preview renderers read live nodes from that store rather than copying node content or labels into tabs.

`chatStore` owns conversation state keyed by `threadId`: messages, drafts, history status, streaming state, binding, model settings, compose mode, and pending attachments. It persists thread identity metadata (binding, built-in settings, and compose mode) without an entry limit so every independent Chat tab rehydrates with the same agent after reload; messages, drafts, history status, streaming state, and attachments remain runtime-only. Preview Workspace stores only the target needed to select a renderer.

`panelStore` owns and persists the outer right-column collapse state, owns the transient Preview fullscreen state, and owns thread-addressed composer focus requests. Opening a Preview target expands the right column; closing a tab does not delete its underlying node or conversation history. `MainLayout` treats the persisted collapse state as authoritative whenever no panel motion is active. A settled collapsed slot is zero-width and clips overflow, while an active open/close motion temporarily releases that clipping; interrupted startup hydration therefore cannot leave translated panel content visible over the Canvas in either persisted state. Fullscreen is intentionally not persisted across reloads.

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

`openChat` activates the most recently used unbound Chat target or creates a new thread and tab when none exists. New conversation always creates an independent `threadId`. A thread with no persisted selection defaults to the built-in Huabu Agent in `operate` mode; persisted per-thread and per-Canvas selections still take precedence.

Open to Side moves the existing semantic target into the other group instead of duplicating it and preserves whether the tab is transient or permanent. Saving an unbound Chat as a Question replaces that tab's target in place, preserving tab identity, position, messages, and draft continuity.

Canvas node double-clicks, Question toolbar compose or replay actions, search results, and connected-node navigation open transiently. New Chat opens are permanent.

## 4. Rendering and Chat sessions

Each group mounts its active tab plus at most one warm inactive tab selected by the greatest `lastActiveSeq`. The warm slot is a bounded runtime optimization rather than persisted topology: React 19 `Activity` keeps that tab's DOM and component state with `mode="hidden"`, cleans up its Effects while hidden, and restarts those Effects when the tab becomes visible again. Activity cleanup and closing a tab do not mark the page as unloading or terminate a thread-owned stream; only the browser page lifecycle suppresses unload-time transport errors.

PDF tabs retain view state in the warm slot, but discard the loaded pdf.js document proxy during Activity cleanup because `react-pdf` destroys that proxy's worker transport while hidden. Page rendering and text indexing remain suspended until the visible tab loads a fresh proxy.

Chat, Question, Note, Text, PDF, and Office tabs are eligible for the warm slot. Eligibility follows the resolved renderer, so a valid World `nodeRef` that presents a source Question is treated as a Question rather than as a generic reference. Web, Audio, Video, and other node types are not retained because hidden native media or iframe work can outlive React Effect cleanup. Closing or replacing a warm tab, deleting its node, or advancing the slot to a more recently active eligible tab unmounts the old tree. The shared runtime scroll cache remains the cold-restore fallback after a real unmount.

`PreviewRenderer` resolves node targets against the current Canvas nodes and World references. Ordinary nodes render through `ExpandedNodePanel`; Question nodes and unbound Chat targets render through `ChatPanel`. An ordinary node's AI summary can be dismissed for the lifetime of the mounted preview without mutating node data.

Every mounted `ChatPanel` receives an explicit `ChatSession` and owning preview tab ID. There is no globally current Chat thread or Question replay pointer, so two groups can render independent conversations without sharing messages, drafts, bindings, attachments, settings, loading state, or stream control.

Dragging a Chat or Note block into an editable Note uses Milkdown's geometric drop position, while its fixed-position indicator is portalled to `document.body` so the Preview panel's compositor transform cannot rebase viewport coordinates in either split group.

PDF area capture routes directly to a Chat or Question conversation that is active in the group beside the PDF. When no conversation is visible beside it, the Canvas's canonical unbound Chat opens to the side and the capture is staged immediately as that thread's pending attachment. The explicit Send to Chat action always produces a thread-owned attachment; the shared dashed selection attachment remains reserved for passive browser text selection.

When a conversation is visible beside an ordinary node, its composer offers that active node as a dashed source candidate. Confirming the candidate stages a thread-owned source attachment that the prompt renderer emits as a structured node reference; switching the node in the adjacent group updates the unconfirmed candidate, while an already confirmed source remains attached to the thread.

For a World `nodeRef` that presents a source Question, the target remains the World presentation node while `AgentConversationView` carries the source Canvas, node, and thread as conversation owner. History, reconnect, agent turns, tools, lifecycle writes, binding, mode, and change records use that owner scope.

An authored Question node remains authoritative for persisted agent mode and fixed binding. A new selectable Question thread inherits the Canvas's current binding unless the node supplies an explicit binding.

## 5. Groups, tabs, and bounds

The workspace contains one or two horizontal groups. Each group owns one active tab, and only the active group receives group-scoped keyboard actions.

Tabs can be reordered within a group or moved across groups with pointer or keyboard drag sensors. Every drop delegates to the pure `moveTab` model action, which repairs ordering, active tabs, and empty source groups.

Pointer dragging keeps a faded source placeholder in the tab strip, portals a labelled tab overlay to `document.body` so transformed panel ancestors cannot offset it from the pointer, and marks the resolved insertion edge of the hovered tab or the end of a group. The visual marker follows the same destination semantics used by `resolveTabDropDestination`. Window blur and document hiding cancel the pointer sensor itself so releasing outside the Electron window cannot leave a tab in a stale dragging state.

Closing an active tab selects the nearest remaining tab in the same group. Moving or closing the final tab in a secondary group removes that group. The workspace keeps one empty primary group as its valid empty state.

A transient tab is one reusable inspection slot per group. Opening another transient target replaces that slot; using its Pin action, double-clicking the tab, or committing a persistent mutation through its renderer promotes it in place. Moving a transient tab into a side group does not promote the moved tab; if that group already has a transient slot, the moved tab replaces the existing disposable slot. Merging groups keeps the most recently active transient slot and drops any older transient slot. Runtime topology changes report every implicitly removed tab before committing the new workspace so mounted authored editors can settle through the same lifecycle boundary as an explicit close; the store then clears tab-addressed focus and opening requests atomically with the topology update. Persistence repair has no mounted editor and only repairs the stored topology.

Permanent tabs are never closed automatically. A group may retain any number of permanent tabs; users close them explicitly, while transient browsing continues to reuse the group's inspection slot.

The activation sequence is an integer stored with the workspace rather than a wall-clock timestamp, making recent-target ordering deterministic in tests and persistence. Rendering also uses this sequence as the per-group LRU order for the single inactive warm slot; it does not add a second recency model.

## 6. Focus and opening position

Editor focus is a runtime-only `{ tabId, nonce }` request. Only the addressed active tab receives it, and its renderer consumes it after focus succeeds so remounting cannot replay stale intent.

Question conversation positioning is a runtime-only `{ tabId, position, nonce }` request where `position` is `last-user` or `bottom`. `MessageList` consumes the request after history hydration and successful positioning. Every scrollable Preview renderer keeps its latest vertical offset in one runtime cache: Chat uses conversation-owner Canvas plus `threadId`, while ordinary nodes use target Canvas plus `nodeId`. Note, PDF, Office, and Web reader renderers register their own scroll element through the shared hook because the outer panel is intentionally non-scrolling. Hidden retained tabs ignore Activity-driven scroll events and Effect cleanup so temporary zero-sized layout cannot overwrite their saved offset. Asynchronous restoration remains active only until the saved offset becomes reachable or wheel, touch, or scrolling-key input signals that the user has taken control. The cache removes an offset after the final target is closed, replaced, or invalidated, and clears unreferenced offsets when a Canvas layout is deleted or evicted from the persisted MRU index. Chat retains its additional unread-opening rule: a saved offset above the latest messages is preserved and exposes the New message action instead of scrolling automatically; a thread without a saved offset uses the requested opening position.

Inactive tabs never count as actively viewed, including a tab retained in hidden Activity. A Question is actively viewed only when its tab is the active tab of a rendered group and the outer right panel is expanded; this rule controls the Canvas open indicator and whether stream completion marks a result as viewed.

Composer focus is addressed by `threadId` through `panelStore`, so opening one Chat cannot steal focus through a request intended for another mounted Chat.

## 7. Persistence and validation

Workspace topology is local UI state stored under one versioned local-storage record per Canvas. Content, messages, drafts, stream handles, and resolved node data are not duplicated into that record.

The current Canvas layout is written synchronously before switching Canvas and by the consolidated `beforeunload` handler. Tab switching and ordinary topology mutations do not write storage immediately.

A capped MRU index retains workspace records for at most 50 Canvases. Evicting an old layout is non-destructive because the record contains presentation topology only.

Persisted input is parsed defensively. Invalid targets, dangling tab IDs, duplicate group references, invalid active IDs, excess groups, duplicate transient slots within one group, and malformed split values are dropped or repaired without preventing the remaining layout from loading. Duplicate transient slots keep the most recently active slot and drop the older disposable slots.

After a command deletes nodes, the web post-effect validates the workspace against the committed live node IDs. Tabs targeting deleted nodes are removed and active IDs or empty groups are repaired by `validateWorkspace`.

Closing a Preview tab does not delete the Canvas node, stop a running turn, or remove server-side Chat history. Successful Canvas deletion calls `deleteWorkspace(canvasId)` to remove its layout and runtime scroll-memory ownership; unreachable layout records are also reclaimed when they fall out of the capped Canvas MRU index.

## 8. Layout and accessibility

`MainLayout` owns the resizable outer right column and mounts `PreviewWorkspace`; `CenterArea` remains Canvas-only. The outer width may grow beyond half the layout for wide document browsing and is capped only by the expanded Layers width plus the minimum Canvas width; the internal split ratio is clamped so both groups remain usable.

Preview fullscreen replaces the visible centre area with Preview Workspace and unmounts the Canvas subtree entirely. Canvas document and selection remain in `canvasStore`, while its locally persisted viewport is restored by `useInitialCanvasViewport` when Canvas remounts after fullscreen; unmounting also guarantees that React Flow portals and compositor layers cannot leak stale Canvas pixels into Preview. Exiting fullscreen is deliberately two-phase: `MainLayout` first paints the ordinary split layout with a Canvas loading placeholder, then remounts Canvas after that feedback has reached one frame, preventing synchronous React Flow construction from making the restore control appear unresponsive. The fullscreen Preview slot clips renderer overflow so content cannot cover the Layer List when that list expands and narrows Preview. The existing Layer List remains available at the left with its normal resize, search, rename, lock, reorder, and collapse behaviour; an unmodified row click opens or activates that node in Preview while fullscreen, whereas modifier clicks retain Layer List multi-selection semantics. When the list is collapsed, `MainLayout` renders the existing Canvas header as a narrow vertical rail containing only the Layer List expansion control. The last Preview group exposes fullscreen and restore controls, `Escape` restores the ordinary layout unless an inner control consumes it, and collapsing Preview also exits fullscreen.

The separator exposes a symmetric pointer target around its visible rule, tracks pointer movement on `window`, and supports keyboard resizing.

Each group uses the WAI-ARIA tabs pattern with a tablist, selected tab, labelled tabpanel, and roving keyboard focus. Only the focused group responds to group-level shortcuts; editable controls, search, menus, and media viewers keep ownership of their own keys.

Tab titles are visually truncated while retaining full accessible labels and tooltips. Tabs do not shrink their action controls when the strip is crowded; the strip scrolls horizontally instead. Close remains visible on every tab, and the one-way Pin action remains visible on transient tabs, so pointer, keyboard, and touch users do not depend on hover to operate a tab. Transient tabs are visually distinct and expose their temporary status and promotion gesture accessibly.

## 9. Integration rules

New user-visible node and Chat open paths must use the Preview Workspace actions rather than independently mutating panel, Canvas, and Chat presentation state.

Renderer code must treat targets as references and resolve mutable data at render time. Adding labels, node snapshots, conversation state, or derived resource keys to persisted tabs creates a second source of truth and is not allowed.

Code that determines visibility must inspect each group's active tab, not every tab in `workspace.tabs` or every mounted renderer, because one inactive renderer may remain mounted in hidden Activity.

Runtime intents such as editor focus, composer focus, and initial message position must stay outside the persisted workspace model and must be addressed to a tab or thread.

Document mutations remain in the Canvas command path. Preview Workspace may request settling or validation at lifecycle boundaries, but it does not directly author Canvas node content or topology.

## 10. Code entry points

| File/dir                                                                                                                                                 | Responsibility                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`apps/web/src/store/previewWorkspace/model.ts`](../../apps/web/src/store/previewWorkspace/model.ts)                                                     | Pure target, tab, group, move, close, validation, and transient rules.                               |
| [`apps/web/src/store/previewWorkspace/store.ts`](../../apps/web/src/store/previewWorkspace/store.ts)                                                     | Zustand binding, Canvas load/flush lifecycle, and runtime tab-addressed requests.                    |
| [`apps/web/src/store/previewWorkspace/persistence.ts`](../../apps/web/src/store/previewWorkspace/persistence.ts)                                         | Versioned per-Canvas local-storage records, repair-on-read, migration seed, and capped Canvas index. |
| [`apps/web/src/store/previewWorkspace/actions.ts`](../../apps/web/src/store/previewWorkspace/actions.ts)                                                 | Canonical user-facing node and Chat open adapters.                                                   |
| [`apps/web/src/components/Panels/PreviewWorkspace/`](../../apps/web/src/components/Panels/PreviewWorkspace)                                              | Workspace layout, groups, tab strips, drag-and-drop, split resizing, and target rendering.           |
| [`apps/web/src/components/Panels/ChatPanel/index.tsx`](../../apps/web/src/components/Panels/ChatPanel/index.tsx)                                         | Session-scoped conversation renderer used by Question and unbound Chat targets.                      |
| [`apps/web/src/components/Panels/ExpandedNodePanel/ExpandedNodePanel.tsx`](../../apps/web/src/components/Panels/ExpandedNodePanel/ExpandedNodePanel.tsx) | Embedded ordinary-node preview renderer.                                                             |
| [`apps/web/src/components/Nodes/question/questionCompose.ts`](../../apps/web/src/components/Nodes/question/questionCompose.ts)                           | Question binding initialization, conversation opening, initial position, and compose focus.          |
| [`apps/web/src/hooks/useActivelyViewingQuestion.ts`](../../apps/web/src/hooks/useActivelyViewingQuestion.ts)                                             | Shared active-visible Question semantics for render and stream completion paths.                     |
| [`apps/web/src/handler/canvasCommand/postEffects.web.ts`](../../apps/web/src/handler/canvasCommand/postEffects.web.ts)                                   | Validates Preview targets after committed node deletion.                                             |
| [`apps/web/src/store/canvasStore/save/unloadFlush.ts`](../../apps/web/src/store/canvasStore/save/unloadFlush.ts)                                         | Consolidated page-unload persistence boundary, including workspace layout flush.                     |
