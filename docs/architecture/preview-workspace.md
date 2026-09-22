# Preview Workspace

Preview Workspace is the only right-side presentation surface on a Canvas page. It hosts node previews, webpage URL tabs, and unbound Chat conversations in one or two tab groups while the Canvas remains mounted in the centre.

The implementation originated in the [Unified Preview Workspace proposal](../proposals/unified-preview-workspace.md). This document is authoritative for the shipped system; the proposal is retained as design and migration history.

## 1. Ownership boundaries

Preview Workspace owns presentation topology: open tabs, tab order, active tabs, groups, split ratio, transient inspection state, and runtime requests addressed to a tab.

`canvasStore` owns Canvas document state and the command pipeline. Preview renderers read live nodes from that store rather than copying node content or labels into tabs.

`chatStore` owns conversation state keyed by `threadId`: messages, drafts, paged display-history state, streaming state, binding, model settings, compose mode, and pending attachments. It persists thread identity metadata (binding, built-in settings, and compose mode) without an entry limit so every independent Chat tab rehydrates with the same agent after reload; messages, history pages and cursors, drafts, streaming state, and attachments remain runtime-only. Preview Workspace stores only the target needed to select a renderer.

Chat history hydration requests the newest configurable number of complete display turns, three by default, from the paginated agent-history endpoint. An active user-started tail counts as a display turn, while continuation records attach to their preceding turn. `Recent chat turns` also sizes the initial presentation window: ordinary opening or reactivating a Chat selects the latest complete turns before message cards mount or Activity Effects reconnect, even when the runtime cache contains the entire conversation. Server display-turn identities keep continuation messages together; live user inputs establish boundaries until history reconciliation supplies server identities. The active turn is never split or discarded.

The explicit Show earlier turns action first reveals another batch of cached-but-hidden turns; only after reaching the cache boundary does it retrieve and prepend the preceding server page. Cached hidden history and the server cursor/has-more state are separate. The client does not retrieve the entire server conversation merely to hide it, and narrowing the presentation window does not discard loaded pages, reset history hydration, or modify drafts, attachments, permissions or streams. The global preference is persisted separately from thread state and applies to future hydration, expansion and recent-window selection.

While a Chat remains visible, new turns extend its presentation window. A genuine stream `done` event records a thread-owned completion identity; it is not inferred from loading becoming false, tool completion, a permission wait or transport termination. At completion, a list following latest compacts to the latest configured turns and stays at the bottom. Compaction pauses while reading older content or following explicit history/search/reading-return navigation. The explicit bottom action may compact and resume following; ordinary activation also resets the window. Background completion never scrolls a hidden or unrelated view. This bounds displayed turn count at safe completion points, not the size of an individual turn or retained cache.

Newest-page refreshes after reconnect or stream completion merge from stable server turn identities so previously fetched older pages remain available while active-tail messages converge with their persisted form. A stale pagination cursor causes a newest-page reload because the server generation changed; ordinary expansion failures leave visible history intact and expose a retry action.

Within a mounted Chat renderer, the thread-scoped composer owns the draft subscription. Draft updates therefore rerender the composer without invalidating `MessageList`; unchanged historical message cards are memoized, while message-array updates and streaming changes continue through the history tree normally.

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
  | { kind: 'chat'; canvasId: string; threadId: string }
  | { kind: 'url'; canvasId: string; url: string };

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

`tab.id` is presentation identity. `isSamePreviewTarget` is the only authority for resource identity: node targets compare `{ canvasId, nodeId }`, Chat targets compare `{ canvasId, threadId }`, and URL targets compare `{ canvasId, url }` after HTTP(S)-only validation and normalization with `URL.href`. Paths, queries, and fragments remain part of URL identity. Open, replacement, and persistence parsing use the same normalization boundary; invalid URL targets do not mutate topology.

The first shipped model allows at most one tab for a semantic target across the workspace. Reopening a target activates its existing tab even when it belongs to the other group.

Titles are derived at render time. Node tabs use the current node label; Chat tabs derive their conversation label. URL tabs show the URL host with the full URL as their accessible name and tooltip, without fetching title metadata. Renaming a node therefore updates its tab without mutating workspace state.

Unbound Chat titles are durable thread host metadata, not tab properties. `ThreadRecord.hostMetadata.huabuConversationTitle`, written through `Agenetes.updateHostMetadata`, persists one current `{ title, source }`, with priority `user > generated > acp > fallback`; lower-priority updates are rejected rather than saved. When no higher-priority host title exists, reads may use the driver's current valid ACP session title; the last valid ACP title is persisted only as the current title with source `acp`, never as a separate candidate. Empty conversations display “New conversation”. Initialization attempts Huabu naming even when ACP is available, using the first user prompt and canonical utility/global-model routing. No usable model or generation failure retains ACP or the first-user fallback and permits a later turn/initialize to retry; title queries never perform paid generation. ACP validation accepts only nonblank, single-line strings whose normalized value is at most 120 characters, with no prompt-text or fixed-prefix filtering. Invalid raw or persisted ACP titles are ignored on query without mutation; invalid updates leave the current host title unchanged. There is no migration for the old unmerged candidate-field shape, and raw driver metadata is untouched. The same backend `ConversationTitleService` names Questions through their canonical node label and protected `conversationTitleSource` provenance instead of thread metadata; current node ownership takes precedence, without two competing title authorities. No hidden automatic title is retained after manual naming. The zod-free policy is available as `normalizeAcpConversationTitle` from `@huabu/shared/conversation-title`; manual title semantics and visual overflow handling are unchanged. The panel header and tab strip read the same Canvas/thread-scoped title cache; clicking the header enables inline rename, with Enter/blur to save and Escape to cancel. Renames before the first send are persisted locally as pending user intent and flushed once the server creates the thread; established names are server-owned.

One workspace-level coordinator batch-loads titles for all open Chat tabs, including unmounted tabs, without loading conversation history on initial hydration, target changes, and browser focus. The backend title service alone normalizes, filters, generates, ranks, and persists titles. The frontend caches the exact backend projection, including an empty or lower-priority result, without reapplying source arbitration or ACP filtering. Stream start/completion and title-bearing `session_info_update` events invalidate only the affected thread's cache; raw ACP titles never become display values directly. An invalidation during a query fences that response and queues one coalesced follow-up query after it settles; ordinary overlapping queries only deduplicate. The stream epoch restarts the bounded retry window for unresolved titles because generation can finish after the answer stream. Untitled realized conversations and pending manual edits can retry; untouched empty tabs do not poll. Stream events do not trigger an immediate all-tabs refresh. Queries started during a manual rename cannot overwrite its optimistic title or settled result; successful saves and rollbacks advance the local revision, while subsequent queries accept newer server facts. A rename during the first send that receives `404 thread_not_found` becomes locally persisted pending intent, just like a pre-send rename, and the existing refresh/stream path flushes it after durable creation. Other failed title requests expose a retry action.

Saving Chat as a Question transfers naming authority through canonical node creation: manual titles become user labels, nonmanual titles become automatic labels, and `conversationTitleSource` preserves provenance without a second title value. The server uses the latest effective backend title when the incoming label is not user/agent-protected. Without a current title, the existing node-creation fallback is unchanged. Thereafter the Canvas node, Preview tab, and Question chat header use only the node label; eligible late generation and ACP updates continue through the shared service's node writer, while manual or agent-owned labels remain protected. See [Question conversion](./question-node.md#3-node-lifecycle). Closing a tab remains non-destructive and does not add a conversation-history browser.

The zod-free shared title utility owns fallback extraction for the server and preprocessing: first Markdown heading, otherwise first nonempty line, with inline formatting removed and a 50-character cap, followed by common whitespace normalization. The frontend does not derive titles from submitted messages or loaded history; it displays “New conversation” until a backend title or local manual edit is available. Manual and ACP title limits remain unchanged. A successful title query attempts pending manual saves even when the response has no title: title absence is not proof that the thread is absent. `404` keeps pending intent without an error banner, and the workspace's finite retry window includes these pending entries; focus/reopen or a later stream can try again. No title operation creates an Agent session solely to name it.

## 3. Opening and target conversion

`openPreviewTarget` is the topology action. It opens or activates a target in the focused group, supports transient inspection, and delegates all ordering and group repair to the pure model.

`openPreviewNode` is the user-facing node adapter. It settles the previously active editable Note or Text when necessary, expands the right panel, opens the node target, and requests editor focus for an explicitly opened Note.

After `CanvasPage` consumes a canonical Node deep link, nodes registered in `NodePreviews` open permanently through `openPreviewNode`; the semantic-target model activates an existing target across groups and promotes an existing transient target instead of duplicating it. Text, Audio, Frame, Space Preview, and other nodes without an expanded renderer remain Canvas-only. The retained URL query is independent from per-Canvas workspace persistence, so a restored tab is activated through the same deduplication and promotion path.

An existing Question conversation opens only when its live node already has a nonempty persisted `threadId`. The deep-link coordinator opens that node target and sends the tab-addressed one-shot `bottom` positioning request; `PreviewRenderer` then derives the conversation owner from the live Canvas node and ordinary Chat mounting hydrates existing history and Profiles. Deep-link handling never calls Question compose or thread-creation helpers, focuses the composer, acknowledges a result as viewed, realizes an ACP workload, spawns an Agent, binds or rebinds a Profile, or sends input. A Question without an existing thread is selected and focused on the Canvas without opening Chat.

Layers primary activation uses the same permanent semantic node targets and passive existing-Question contract. It opens or activates nodes registered by `hasNodePreview` regardless of whether Canvas is mounted, and it opens an existing Question target followed by the same tab-addressed `bottom` request. It does not reopen a node already active in any visible group, because `openPreviewNode` intentionally emits a fresh Note editor-focus request for explicit opens. Inactive, restored, and transient targets still pass through `openPreviewNode`, so the model activates across groups and promotes rather than duplicates them. Frame, legacy Group, idle Question, Agent-without-thread, and other unsupported rows remain Canvas-only; Frame disclosure is owned by Layers rather than Preview Workspace.

`openPreviewUrl` is the desktop document-link adapter. Expanded `NotePreview` and Chat's `MilkdownMessageCard` both explicitly select `linkActivation="plain"` and use `openDocumentLink`, which chooses desktop preview or external browser navigation through the existing Electron detection. Note supplies its source node ID and Chat supplies its source thread ID. In the web app, plain clicks open a browser tab without changing the workspace. On desktop, the adapter validates the URL, finds the matching source node or unbound Chat tab, promotes it, and opens a permanent URL tab in its group even when the other group is focused; a source Note is also settled before navigation. The source inspection slot is not replaced. Without a matching source tab, opening falls back to the focused group. Existing URLs are activated wherever their tab already lives. URL tabs use the ordinary move, split, merge, close, Canvas-switch, and unload persistence paths; they create no Canvas nodes or Chat threads.

Note and Chat links share the pointer cursor through `data-link-activation="plain"`. Activation is not inferred from callback presence: canvas `NoteNode` uses `modifier`, suppressing native plain-click navigation while allowing the event to bubble for node selection. Platform-modifier clicks open externally on both Note and Chat rather than invoking their host callback. All Milkdown link handlers suppress drag and repeated-click navigation, including surfaces without a callback; the first eligible stationary click opens synchronously and cannot be cancelled by a later double-click. See [Note link activation](./note-node.md#6-link-activation) for the shared gesture contract and single editable-editor link panel used by toolbar, shortcut, and hover. Expanded Note supports creating links from selected text and editing existing links; Chat remains read-only and has no link-edit form.

`openChat` activates the most recently used unbound Chat target or creates a new thread and tab when none exists. New conversation always creates an independent `threadId`. A thread with no persisted selection defaults to the built-in Huabu Agent in `operate` mode; persisted per-thread and per-Canvas selections still take precedence.

Open to Side moves the existing semantic target into the other group instead of duplicating it and preserves whether the tab is transient or permanent. Saving an unbound Chat as a Question replaces that tab's target in place, preserving tab identity, position, messages, and draft continuity.

Canvas node double-clicks, Question toolbar compose or replay actions, search results, and connected-node navigation open transiently. New Chat opens are permanent.

## 4. Rendering and Chat sessions

Each group mounts its active tab plus at most one warm inactive tab selected by the greatest `lastActiveSeq`. The warm slot is a bounded runtime optimization rather than persisted topology: React 19 `Activity` keeps that tab's DOM and component state with `mode="hidden"`, cleans up its Effects while hidden, and restarts those Effects when the tab becomes visible again. Activity cleanup and closing a tab do not mark the page as unloading or terminate a thread-owned stream; only the browser page lifecycle suppresses unload-time transport errors.

PDF tabs retain view state in the warm slot, but discard the loaded pdf.js document proxy during Activity cleanup because `react-pdf` destroys that proxy's worker transport while hidden. Page rendering and text indexing remain suspended until the visible tab loads a fresh proxy.

Chat, Question, Note, Text, PDF, and Office tabs are eligible for the warm slot. Node eligibility follows the live node type, without a World-reference projection. Web, Audio, Video, and other node types are not retained because hidden native media or iframe work can outlive React Effect cleanup. Closing or replacing a warm tab, deleting its node, or advancing the slot to a more recently active eligible tab unmounts the old tree. Ordinary node previews retain the shared runtime scroll cache as their cold-restore fallback; Chat uses explicit best-effort reading return instead of automatic cold restoration.

`PreviewRenderer` resolves node targets against the current Canvas nodes. Ordinary nodes render through `ExpandedNodePanel`; Question nodes and unbound Chat targets render through `ChatPanel`. An ordinary node's AI summary can be dismissed for the lifetime of the mounted preview without mutating node data.

Chat, Question, and ordinary node content headers share [`InlineEditableTitle`](../../apps/web/src/components/Common/InlineEditableTitle.tsx), composed from the common `Button` and `TextInput`. Display and edit states use the same compact spacing and normal-weight small text across embedded and standalone panels; display titles use the muted foreground token and truncate without shrinking adjacent actions. The component owns focus/select, IME-safe Enter submission, blur submission, and Escape cancellation without duplicate blur commits. Callers retain draft state, identity resets, permissions, validation, and their existing node or conversation persistence paths. Connection badges, connected-node navigation, and node-specific header actions remain separate controls. The node header matches the tab strip's first-tab alignment: `px-2.5`, a 14px icon column, and `gap-1.5`. Its navigation button retains a 24px hit target centered on that column, and the title offsets its internal padding and border equally in display and editing states. No empty icon slot is reserved when navigation is unavailable; document-body and horizontally scrolled tab positions remain independent.

Node headers use `InlineEditableTitle`'s `width="fill"` layout: both the display button (including its tooltip wrapper) and the editing field fill the available title slot after navigation and right-side actions. Only the left alignment follows the tab strip; the tab's width cap and the content-sized editor's fixed input width do not apply. Chat retains content sizing so its connection badge remains adjacent to its title.

URL targets render through `UrlPreview`: a direct remote iframe with `sandbox="allow-scripts allow-forms"`, `referrerPolicy="no-referrer"`, and an always-visible external-open button. It has no same-origin, popup, top-navigation, preload, or interactive-view bridge privileges, even for a URL that redirects to the app origin. It does not use node ingestion, server fetch/extraction endpoints, reader artifacts, metadata requests, or iframe load/timeout failure detection. Sites can refuse framing or require storage, cookies, popups, or other unavailable capabilities; the external-open action remains usable regardless. Unlike node-backed `WebPreview`, this renderer intentionally has no reader fallback.

The URL toolbar uses a compact address surface with an emphasized host, subdued path, and truncation for narrow groups; the full destination remains available on hover. External opening uses the shared icon-only Button with a localized tooltip and accessible name rather than a wide text action.

URL tabs are not eligible for the warm slot, and their cross-origin iframe scroll state cannot be read or restored. Switching away unmounts the iframe; reopening starts from the target URL rather than retaining hidden page activity or in-frame navigation history. Source Note and Chat tabs remain eligible for ordinary warm retention and scroll restoration.

Every mounted `ChatPanel` receives an explicit `ChatSession` and owning preview tab ID. There is no globally current Chat thread or Question replay pointer, so two groups can render independent conversations without sharing messages, drafts, bindings, attachments, settings, loading state, or stream control.

Chat and Canvas Ink submissions delegate to the same component-independent `agentTurnController`, which owns captured sources, save barriers, per-thread stream claims, event reduction, lifecycle settlement, typed retry, and durable acceptance. Closing or unmounting Chat does not own the stream; any mounted view of the same thread can stop it. A confirmed Stop applies its acceptance before releasing the local claim, while a transport-unknown or `stopped: false` result keeps the original stream and loading state alive as the reconciliation channel instead of making resubmission appear safe.

Dragging a Chat or Note block into an editable Note uses Milkdown's geometric drop position, while its fixed-position indicator is portalled to `document.body` so the Preview panel's compositor transform cannot rebase viewport coordinates in either split group.

PDF area capture routes directly to a Chat or Question conversation that is active in the group beside the PDF. When no conversation is visible beside it, the Canvas's canonical unbound Chat opens to the side and the capture is staged immediately as that thread's pending attachment. The explicit Send to Chat action always produces a thread-owned attachment; the shared dashed selection attachment remains reserved for passive browser text selection.

When a conversation is visible beside an ordinary node, its composer offers that active node as a dashed source candidate. Confirming the candidate stages a thread-owned source attachment that the prompt renderer emits as a structured node reference; switching the node in the adjacent group updates the unconfirmed candidate, while an already confirmed source remains attached to the thread.

Ordinary Question sessions retain `AgentConversationView`: presentation and owner identify the same active Canvas/node, and the owner carries the Question's `threadId`. History, reconnect, Agent turns, tools, lifecycle writes, binding, mode, and change records use that owner scope. Legacy World `nodeRef` sessions and source-reference resolution are removed. Space Preview scenes do not mount source Question conversations; the user enters the source Space to open one.

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

Question conversation positioning is a runtime-only `{ tabId, position, nonce }` request where `position` is `last-user` or `bottom`. `MessageList` consumes an explicit request after history hydration and successful positioning. Ordinary Chat activation (warm switch, cold mount, close/reopen or opening after reload) defaults to the latest content in the recent-turn window, not an older saved offset. Each group supplies an activation identity that changes only when its active tab changes; repeated clicks on the active tab, other-group focus and ordinary rerenders do not reset the window. Explicit positioning and conversation-search navigation take precedence over the ordinary default. Search addresses the destination thread, reveals its cached history before DOM match navigation, and suspends following/compaction.

Every scrollable Preview renderer uses a runtime cache: Chat keys by conversation-owner Canvas plus `threadId`, while ordinary nodes key by target Canvas plus `nodeId`. Chat remembers an intentional reading message and viewport offset without overwriting them on programmatic bottom navigation. When available on activation, Return to previous reading position reveals the cached target and restores it best effort, outside the activation path. An unavailable target is reported explicitly; this action does not fetch history solely for recovery or persist across reload. Live-to-history ID replacement can make an old bookmark unavailable. Prepending earlier content anchors the first visible message and compensates for bounded late resizing unless user input takes control. Note, PDF, Office, and Web reader renderers keep automatic offset restoration through the shared hook because the outer panel is intentionally non-scrolling. Hidden retained tabs ignore Activity-driven scroll events and Effect cleanup. The cache removes an offset after the final target is closed, replaced, or invalidated, and clears unreferenced offsets when a Canvas layout is deleted or evicted from the persisted MRU index.

Chat shows a localized Back to bottom action whenever the viewport is more than 50px from the bottom, independently of unread detection. The same action reads New message when new messages or an updated streaming tail arrive while reading above the bottom; prepending older history does not count as new output. Clicking the action and automatic bottom-follow use instant container-local scrolling, not smooth animation. The action is hidden only after measuring the viewport within the 50px bottom tolerance. Content and viewport ResizeObservers maintain bottom-follow through asynchronous Markdown, tool, attachment, font, and panel-size changes. Upward wheel/touch gestures and native scrolling pause following; returning near the bottom or clicking the action resumes it. Resize compensation does not pull a paused reader to the bottom or compete with older-page prepend anchoring. Inactive retained tabs do not perform this scrolling, and observers disconnect on effect cleanup. Native wheel and touch scrolling remain unchanged.

Inactive tabs never count as actively viewed, including a tab retained in hidden Activity. A Question is actively viewed only when its tab is the active tab of a rendered group and the outer right panel is expanded; this rule controls the Canvas open indicator and whether stream completion marks a result as viewed.

Composer focus is addressed by `threadId` through `panelStore`, so opening one Chat cannot steal focus through a request intended for another mounted Chat.

## 7. Persistence and validation

Workspace topology is local UI state stored under one versioned local-storage record per Canvas. Content, messages, drafts, stream handles, and resolved node data are not duplicated into that record.

The current Canvas layout is written synchronously before switching Canvas and by the consolidated `beforeunload` handler. Tab switching and ordinary topology mutations do not write storage immediately.

A capped MRU index retains workspace records for at most 50 Canvases. Evicting an old layout is non-destructive because the record contains presentation topology only.

Persisted input is parsed defensively. Invalid targets, dangling tab IDs, duplicate group references, invalid active IDs, excess groups, duplicate transient slots within one group, and malformed split values are dropped or repaired without preventing the remaining layout from loading. Duplicate transient slots keep the most recently active slot and drop the older disposable slots.

URL targets extend the existing version-1 record; no separate runtime overlay or storage namespace is introduced. URL strings are validated and canonicalized on restore, and malformed or cross-Canvas targets are rejected. Only the destination URL is persisted, not fetched content or in-frame history. Node deletion validation leaves URL and Chat tabs intact because neither target depends on a Canvas node.

After a command deletes nodes, the web post-effect validates the workspace against the committed live node IDs. Tabs targeting deleted nodes are removed and active IDs or empty groups are repaired by `validateWorkspace`.

Closing a Preview tab does not delete the Canvas node, stop a running turn, or remove server-side Chat history. Successful Canvas deletion calls `deleteWorkspace(canvasId)` to remove its layout and runtime scroll-memory ownership; unreachable layout records are also reclaimed when they fall out of the capped Canvas MRU index.

For repeatable Chat activation measurements, explicitly enable the test-only production playground with `VITE_CHAT_PERFORMANCE_FIXTURE=true pnpm --filter @huabu/web build`, then run `pnpm --filter @huabu/web exec playwright test --config e2e/chat-activation.config.ts`. The fixture feeds full cached rich-turn arrays into the real MessageList, uses Activity and the workspace retention selector, and distinguishes retained activation from cold remount. It checks mounted rows, cache-first expansion and conditional completion compaction. The same-build full-list/windowed comparison times the captured tab click through destination rows and Milkdown headings becoming ready, followed by one animation frame for a paint opportunity. Reports include raw samples and median/p95; this is not a compositor trace, composer-input measurement, real-user measurement or universal latency guarantee. Normal unflagged production builds do not expose this playground.

## 8. Layout and accessibility

`MainLayout` owns the resizable outer right column and mounts `PreviewWorkspace`; `CenterArea` remains Canvas-only. The outer width may grow beyond half the layout for wide document browsing and is capped only by the expanded Layers width plus the minimum Canvas width; the internal split ratio is clamped so both groups remain usable.

Preview fullscreen replaces the visible centre area with Preview Workspace and unmounts the Canvas subtree entirely. Canvas document and selection remain in `canvasStore`, while its locally persisted viewport is restored by `useInitialCanvasViewport` when Canvas remounts after fullscreen; unmounting also guarantees that React Flow portals and compositor layers cannot leak stale Canvas pixels into Preview. Exiting fullscreen is deliberately two-phase: `MainLayout` first paints the ordinary split layout with a Canvas loading placeholder, then remounts Canvas after that feedback has reached one frame, preventing synchronous React Flow construction from making the restore control appear unresponsive. The fullscreen Preview slot clips renderer overflow so content cannot cover the Layer List when that list expands and narrows Preview. The existing Layer List remains available at the left with its normal resize, search, rename, lock, reorder, disclosure, and accessible tree behaviour; unmodified primary activation opens supported node targets in both ordinary and fullscreen layouts, skips Canvas reveal while React Flow is unmounted, and expands Frame hierarchy without invoking Preview. Modifier clicks retain Layer List multi-selection semantics. When the list is collapsed, `MainLayout` renders the existing Canvas header as a narrow vertical rail containing only the Layer List expansion control. The last Preview group exposes fullscreen and restore controls, `Escape` restores the ordinary layout unless an inner control consumes it, and collapsing Preview also exits fullscreen.

The separator exposes a symmetric pointer target around its visible rule, tracks pointer movement on `window`, and supports keyboard resizing.

Each group uses the WAI-ARIA tabs pattern with a tablist, selected tab, labelled tabpanel, and roving keyboard focus. Only the focused group responds to group-level shortcuts; editable controls, search, menus, and media viewers keep ownership of their own keys.

Tab titles are visually truncated while retaining full accessible labels and tooltips. Tabs do not shrink their action controls when the strip is crowded; the strip scrolls horizontally instead. Close remains visible on every tab, and the one-way Pin action remains visible on transient tabs, so pointer, keyboard, and touch users do not depend on hover to operate a tab. Transient tabs are visually distinct and expose their temporary status and promotion gesture accessibly.

## 9. Integration rules

New user-visible node, URL, and Chat open paths must use the Preview Workspace actions rather than independently mutating panel, Canvas, and Chat presentation state.

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
| [`apps/web/src/store/previewWorkspace/actions.ts`](../../apps/web/src/store/previewWorkspace/actions.ts)                                                 | Canonical user-facing node, document-link URL, and Chat open adapters.                               |
| [`apps/web/src/utils/openDocumentLink.ts`](../../apps/web/src/utils/openDocumentLink.ts)                                                                 | Shared Note/Chat HTTP(S) host navigation with source identity.                                       |
| [`apps/web/src/components/Panels/PreviewWorkspace/UrlPreview.tsx`](../../apps/web/src/components/Panels/PreviewWorkspace/UrlPreview.tsx)                 | Bridge-free sandboxed URL rendering with an unconditional external-open action.                      |
| [`apps/web/src/components/Panels/PreviewWorkspace/`](../../apps/web/src/components/Panels/PreviewWorkspace)                                              | Workspace layout, groups, tab strips, drag-and-drop, split resizing, and target rendering.           |
| [`apps/web/src/components/Panels/ChatPanel/index.tsx`](../../apps/web/src/components/Panels/ChatPanel/index.tsx)                                         | Session-scoped conversation renderer used by Question and unbound Chat targets.                      |
| [`apps/web/src/components/Panels/ExpandedNodePanel/ExpandedNodePanel.tsx`](../../apps/web/src/components/Panels/ExpandedNodePanel/ExpandedNodePanel.tsx) | Embedded ordinary-node preview renderer.                                                             |
| [`apps/web/src/components/Nodes/question/questionCompose.ts`](../../apps/web/src/components/Nodes/question/questionCompose.ts)                           | Question binding initialization, conversation opening, initial position, and compose focus.          |
| [`apps/web/src/hooks/useActivelyViewingQuestion.ts`](../../apps/web/src/hooks/useActivelyViewingQuestion.ts)                                             | Shared active-visible Question semantics for render and stream completion paths.                     |
| [`apps/web/src/handler/canvasCommand/postEffects.web.ts`](../../apps/web/src/handler/canvasCommand/postEffects.web.ts)                                   | Validates Preview targets after committed node deletion.                                             |
| [`apps/web/src/store/canvasStore/save/unloadFlush.ts`](../../apps/web/src/store/canvasStore/save/unloadFlush.ts)                                         | Consolidated page-unload persistence boundary, including workspace layout flush.                     |
