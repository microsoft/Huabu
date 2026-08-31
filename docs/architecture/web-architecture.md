# Web App Architecture (`apps/web/src/`)

> Structure, dependency rules, and conventions for the frontend. The point of
> this doc is the **layering rules** below — not an exhaustive file listing
> (those rot fast; `ls` the dir for the current files).
> Last updated: 2026-08-10

---

## 1. Top-level layout

```
apps/web/src/
├── App.tsx        # Router + WorkspaceGuard
├── main.tsx       # ReactDOM entry
├── index.css      # Global CSS / design tokens
├── pages/         # Production route-level pages & app shell
│   └── playground/ # Development-only visual and interaction test routes
├── components/    # Reusable UI (no business logic): Common, Nodes, Panels, Messages, Milkdown, CodeMirror, Search
├── handler/       # Pure processing logic, no React: canvasCommand/, snap/, pdfHighlight/
├── hooks/         # Shared React hooks
├── store/         # Zustand global state
├── api/           # Backend API clients (one file per endpoint group)
├── i18n/          # i18next setup, locale resources, and translation helpers
├── config/        # Static config, constants, and validated external handbook URL
└── utils/         # Generic utilities (non-React)
```

---

## 2. Dependency rules (the important part)

The web app, docs app, and shared package use the same React 19 runtime and type versions. Keep `react`, `react-dom`, `@types/react`, and `@types/react-dom` aligned across those workspaces because the web TypeScript project compiles shared package source directly.

```
pages → components, handler, hooks, store, api, config, utils
components → hooks, store, utils, config
handler → utils, config, api, store (read-only), other handler modules
hooks → store, api, handler, utils, config
store → api, handler, utils, config
api → config
utils → config   (no React imports except Common re-exports)
config → (leaf — imports nothing internal)
```

**Never import upward** — e.g. `utils/` must not import from `components/` or `pages/`.

---

## 3. Where the canvas engine lives

The canvas-command **executor, command handlers, post-effects, and delta logic
are NOT in the web app** — they were extracted to the shared package
[`packages/shared/src/canvas-engine/`](../../packages/shared/src/canvas-engine) so the
server can run the same engine (headless executor). See
[canvas-command-architecture.md](./canvas-command-architecture.md).

What stays in `apps/web/src/handler/canvasCommand/`:

- `uiIntent.ts` — UI gesture → `CanvasUiIntent` types
- `resolvers/` — resolve ambiguous gestures (selection / clipboard / drag) into commands
- `preprocess.ts` — node preprocessing trigger (calls the server)
- `postEffects.web.ts` — web-only post-commit effects (transition cleanup, deferred frame-fit, history snapshot)
- `nodeInputBuilders.ts`, `utils/` — input assembly + local helpers

---

## 4. Conventions

1. **Use the `@/` alias** for cross-directory imports (`@/store/canvasStore`); relative paths only within the same subtree.
2. **No `.ts` / `.tsx` extensions** in import paths.
3. **New UI primitives** go in `components/Common/` — check existing ones first (also enforced by [copilot-instructions.md](../../.github/copilot-instructions.md)).
4. **New canvas commands** are added to the shared engine `packages/shared/src/canvas-engine/commands/` + registered in its `index.ts` (`HANDLERS` / `COMMAND_META`), not in the web app.
5. **Shared hooks** belong in `hooks/`; single-component hooks stay co-located.
6. **Barrel exports** (`index.ts`) provide clean import paths in `handler/`, `utils/io/`, `utils/node/`.
7. **Design tokens only** — never raw hex / Tailwind palette / ShadCN aliases. The token declarations in [`apps/web/src/index.css`](../../apps/web/src/index.css) are authoritative; reusable UI contracts live in [`apps/web/src/components/Common/`](../../apps/web/src/components/Common/).
8. **Development playgrounds** belong in `pages/playground/`, use route-level lazy imports, are registered only when `import.meta.env.DEV` is true, and live outside `WorkspaceGuardLayout` so visual testing does not require an active workspace.
9. **Keep the first-screen graph small** — everything statically reachable from `main.tsx` is evaluated before React's first paint, and on the desktop that is the dominant cold-start cost. The canvas route is lazy, the editor toolchain is reached only through dynamic imports, and shared vendor libraries have explicit `manualChunks` homes. See [desktop-startup.md § 3](./desktop-startup.md#3-the-first-screen-bundle-boundary) before adding a static import to anything the app shell reaches.

Space Preview is the intentional exception to ordinary node rendering: it consumes a sanitized server scene through one target-keyed external-store cache and draws inert SVG instead of mounting target node components or a nested React Flow. See [space-preview.md](./space-preview.md).

### Toast duration contract

[`Toast`](../../apps/web/src/components/Common/Toast.tsx) derives its default auto-dismiss duration from tone: `danger` toasts persist until dismissed, while `neutral`, `info`, `success`, and `warning` toasts dismiss after 3000 ms. Callers may explicitly set `duration` to override either default, including a positive duration for a transient danger message or `0` for any persistent message.

### Clipboard contract

Canvas copy carries Huabu's serialized node payload so that pasting back into Huabu preserves node identity and artifact ownership. The payload always rides in `text/html`; the other representations exist for applications outside Huabu:

`Cmd/Ctrl+C` preserves the browser's native copy behavior when the user has an actual text selection in an input, editor, preview, or panel. If an editor merely retains focus with a collapsed caret, the shortcut copies the selected Canvas nodes instead; retained editor focus must not turn node copy into a silent no-op.

| Selection              | `text/plain`                       | `text/html`                                                  | `image/png` |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------ | ----------- |
| Exactly one image node | —                                  | `<img src="data:…" data-huabu-nodes="<base64 payload>">`     | the image   |
| Anything else          | readable text (omitted when empty) | `<span data-huabu-nodes="<base64 payload>">same text</span>` | —           |

The payload moved out of `text/plain` because plain-text targets outside Huabu would otherwise receive raw JSON. `text/html` was chosen over a `web ` custom format because custom formats are Chromium-only on the read side, while `DataTransfer.getData('text/html')` works synchronously in every browser — which matters because all paste entry points are synchronous `paste` handlers. The image is inlined as a `data:` URL rather than linked by artifact URL because rich-text targets often prefer `text/html` over `image/png` and cannot reach Huabu's local API origin. A single image node writes no `text/plain` at all, so pasting it outside Huabu produces an image and nothing else.

The readable text is produced by [`nodesToPlainText`](../../apps/web/src/utils/io/nodeToPlainText.ts): `note` / `text` / `question` paste their `content`, `web` pastes its `src`, file-backed and container nodes paste their label, and `image` / `sketch` / `nodeRef` / `frameRef` contribute nothing. Multi-node selections join the non-empty parts with a blank line. Non-image copies repeat that same text inside the `text/html` element so rich-text targets do not paste an empty element; newlines become `<br>` there, because rich-text targets prefer `text/html` and HTML would otherwise collapse a multi-line note into one line.

All representations are written through a single `ClipboardItem` by `copyCanvasClipboard`. One copy gesture only authorizes one clipboard write, so writing `text/plain` first as a safety net makes the real write fail with `NotAllowedError` and silently drops the image.

Read paths must go through `readHuabuClipboardPayload` (or `readHuabuClipboardPayloadAsync` on the Clipboard-API fallback path), which prefers `text/html` and falls back to `text/plain`. The fallback keeps clipboard contents written by older builds working. Unsupported Clipboard APIs, inaccessible sources, and image conversion failures all fall back to writing the serialized node payload to `text/plain`, which degrades external pastes to JSON but keeps Huabu-to-Huabu paste working.

The Image expanded preview header exposes explicit Copy image and Download image content actions through the shared `PreviewHeaderSlot`; the Canvas node toolbar retains only node-level actions such as Open Large View. Copy image writes pixels only through `copyImageToClipboard`: PNG bytes pass through, while other browser-decodable raster or vector sources are rendered to PNG with `createImageBitmap` and an `HTMLImageElement` fallback. Clipboard API unavailability, permission denial, source fetch failure, or decode/encode failure produces a persistent error toast with a Download image action instead of silently reporting success. This action is distinct from Canvas `Cmd/Ctrl+C`, which must continue carrying the Huabu node payload for round-trip paste.

Image asset identity is separate from displayed geometry. `data.src` identifies the original uploaded, generated, inline, or remote source; top-level `style.width` and `style.height` only control its Canvas rectangle and never resample or replace that source. Explicit snapshot operations may create internal transformed PNG artifacts for agent vision, but ordinary geometry resize does not create image variants.

### Cross-canvas paste and artifact ownership

Artifacts are canvas-owned, so a paste into a different Canvas than the one the payload was copied from must clone every referenced file into the destination before dispatching `PASTE_CLIPBOARD`; otherwise deleting the source Canvas would orphan the pasted node. A node references artifacts two ways, and `pasteNodes` walks both from the same shared source of truth in [`artifact-url.ts`](../../packages/shared/src/utils/artifact-url.ts):

| Reference shape                 | Field source             | Rewrite                                                    |
| ------------------------------- | ------------------------ | ---------------------------------------------------------- |
| Dedicated top-level field       | `ARTIFACT_DATA_FIELDS`   | field value replaced with the cloned key                   |
| Image embedded in Markdown body | `markdownArtifactFields` | each `![…](<key>)` destination rewritten to the cloned key |

The Markdown walk is what keeps images inside a `note` alive across Canvases — they live in the body string, not in `data.src`. It is scoped by node type (`markdownArtifactFields`) because `content` also exists on `text` and `question` nodes, whose bodies are plain prose that must not be rewritten. `parseArtifactRef` decides what is cloneable: bare keys and legacy canvas-scoped URLs are, while `data:`, `blob:`, and external `http(s)` sources are left verbatim. Clones are deduplicated per `(source canvas, key)` for the whole paste, and a failed clone falls back to the original key so the node renders the server's missing-artifact placeholder instead of blocking the paste. Because the clone round-trips are async, the result is dropped if the user has navigated to a different Canvas by the time they settle. Same-canvas pastes keep sharing the original artifact and stay on the synchronous fast path.

## Workspace routes and World

`/` is the workspace landing redirect. When the persisted World setting is enabled it redirects to the hidden World through `/canvas/:worldCanvasId`; otherwise it redirects to `/spaces`. The ordinary Space List remains a sibling page at `/spaces`, and every Canvas scope, including World, continues to use the existing `CanvasPage` and `/canvas/:canvasId` route.

The World setting defaults to disabled. Enabling it exposes the World navigation entry and changes subsequent workspace landing to World without deleting or resetting `.world`.

`CanvasRefNode` renders a canonical Portal from persisted `targetCanvasId` plus one batched ordinary-Space title map loaded when World opens. Portal activation uses double-click, Enter while selected, or its Open action. A missing title after the Space list has loaded is rendered as an explicit broken reference; transient source titles are never persisted into World topology.

`FrameRefNode` and `NodeRefNode` keep persistent target identity separate from a runtime `worldReferences` map populated by the batch reference endpoint. A `frameRef` renders as a World Container around its recursively pinned snapshot descendants; a `nodeRef` renders the referenced leaf card. The resolved source projection includes label/type/summary/preview/revision and, for question nodes, thread/lifecycle/mode/binding fields. References render source details or an explicit missing-Space/missing-node placeholder and refresh on World load, shortcut open, window focus, headless turn start/end, and active-World Pin/Unpin completion. World selections expose Unpin for selected reference entries.

Source Spaces resolve the same reference endpoint against the workspace World and keep only the derived `pinnedSourceNodeIds` projection — the ids of that Space's own nodes that currently have a World reference. It shares the reference refresh boundaries (canvas load, window focus, Pin/Unpin completion) plus World-setting toggles, and it is resolved only while the World setting is enabled, so a disabled World performs no extra request and shows no pin affordance at all. Single selection renders one stateful Pin toggle whose highlighted state is the node's current pin state; multi-selection collapses into the same toggle when the whole selection agrees and falls back to explicit Pin-all / Unpin-all buttons when it is mixed. These actions drain pending, in-flight, and coalesced structure writes before calling the server command boundary and never construct positions, hierarchy, or references in web state.

Opening a resolved question `nodeRef` leaves World as the active Canvas and opens its node target in Preview Workspace: the World `nodeRef` is the presentation anchor while the source question Canvas/node/thread is the conversation owner. `PreviewRenderer` builds an explicit `ChatSession`, and owner-aware helpers route history, reconnect, agent streams, lifecycle mutations, binding/mode, and change-record loads to the source. Headless turns send no World selection. Source changes are not previewed against World; the review notice routes to the source Space with a one-shot `previewNode` navigation intent that opens the owner Question tab after the Canvas loads.

The web keeps undo/redo managers in a registry keyed by `canvasId` while retaining one active Canvas store. Switching between World and a Space activates the target manager instead of clearing the scope being left; an authoritative reload of the already-active Canvas still clears that Canvas's stale history. First-version Pin/Unpin does not create a snapshot entry: any actual `frameRef` / `nodeRef` membership or hierarchy change, including recursive adoption or removal with a broken Portal subtree, clears the corresponding World manager because the protected identities cannot be recreated through legacy full-state restore. A routed mutation received while a source Space is active leaves that Space's independent history unchanged.

The keyboard shortcut catalog may retain internal runtime bindings with `hidden: true`; `getKeyboardShortcutSections()` excludes them from the user-facing modal. Removed bindings must be deleted from the catalog rather than left as display-only entries.

Preview Workspace state, rendering, tab/group behavior, Chat isolation, runtime focus requests, persistence, and validation are specified in [preview-workspace.md](./preview-workspace.md); the summary below records only how that subsystem fits into the wider web application.

The Expanded Node Panel derives connected-node navigation from the active Canvas edges without adding persisted navigation state. One relationship-menu trigger sits at the far left before the node title and groups destinations as sources, neighbors, and destinations instead of exposing three persistent toolbar buttons. Node-specific preview actions sit on the right before a divider and the view controls. A `forward` arrow follows the edge's source-to-target endpoints, a `backward` arrow reverses them, and a `both` arrow contributes the neighbor to both source and destination groups; a `none` edge has no directional meaning and appears in the neighbor group. Neighbors follow Canvas node order after missing endpoints, self-loops, and duplicates are removed. Bare Left/Right Arrow actions switch directly when one directional neighbor exists or open the relationship menu focused on the matching group when several exist; neutral connections remain menu-driven so the directional shortcuts do not imply an invented order. Editable controls, search, menus, media controls, and embedded viewers retain arrow-key ownership. Switching calls `openPreviewNode` and does not select or reveal the destination on the Canvas. It opens transiently: navigating between connected nodes is browsing, so it reuses the preview group's inspection slot rather than accumulating a tab per neighbor.

Canvas-wide search keeps its query and results mounted when focus moves elsewhere. Its capture-phase Enter and Arrow navigation owns events from the search input, result list, and non-interactive Canvas targets, including React Flow node wrappers focused by live-follow; editable surfaces and other controls in Chat, Preview, or Canvas retain their native keyboard behavior without requiring the search to close.

The Canvas Layer panel surfaces hydrated `contentMissing` and `artifactMissing` state in two places: each affected row carries a warning status with a kind-specific tooltip, and a count summary below the search and type-filter controls toggles a flat missing-only view. Missing-only filtering intersects with type chips, excludes not-yet-imported external notes, can be cleared from the summary, and exits automatically when the missing count reaches zero. Canvas text search remains the active result surface while its query is non-empty, so the summary preserves its count but disables missing-filter changes until search is cleared.

Preview Workspace is the only right-side presentation surface. `MainLayout` mounts it in the collapsible right column and `CenterArea` hosts only the Canvas. The floating Bot button opens and focuses the most recently active Chat tab, or creates one when none exists; it never collapses the workspace, whose own header control owns that action. Each Canvas persists one workspace containing one or two horizontal groups, semantic node or unbound-Chat targets, active tabs, split ratio, and deterministic activation sequence. Reopening a target activates its existing tab across groups; Open to Side moves it instead of duplicating it. Explicit opens are permanent, while confirmed Canvas search results and connected-node browsing use one reusable transient inspection tab per group. Transient tabs use italic titles and an accessible tooltip that identifies the temporary preview and its double-click-to-keep action. Double-clicking the tab or making a persistent mutation through its renderer promotes it in place: Preview Workspace owns the lifecycle transition, while Chat and Expanded Node renderers only report semantic commits such as sending a message, changing an attachment or thread setting, renaming a node, or editing node content. Moving through search results, scrolling, and editing an unsent draft do not promote the tab. Permanent tabs remain open until the user closes them or their target node is deleted; browsing stays bounded by reusing each group's transient inspection slot. The workspace tab strip and embedded Chat or Expanded Node action bars share a 36px height; the tab strip owns the primary title and close action. New conversation creates an independent thread-backed Chat tab in the focused group, and Save Chat as Question converts that tab's target in place. Tabs use shared pointer and keyboard drag sensors, but every drop delegates to the workspace model's `moveTab` action for ordering, cross-group movement, active-tab repair, and empty-group removal. The old single Chat panel, side-by-side centre preview, replace-Canvas mode, feature flag, and Settings toggle no longer exist. See [`docs/proposals/unified-preview-workspace.md`](../proposals/unified-preview-workspace.md).

Explicit node opens create a runtime-only `{ tabId, nonce }` editor-focus request in Preview Workspace. Only the addressed tab receives the request, and its renderer consumes the request after focusing so a later remount cannot replay stale intent; ordinary tab activation does not request editor focus.

Question conversation opens similarly create a runtime-only `{ tabId, position, nonce }` request for `last-user` or `bottom` message positioning. The mounted MessageList consumes it only after history hydration and successful positioning, so inactive tabs and later remounts cannot replay stale scroll intent. Preview Workspace layout remains local UI state and is written synchronously both when switching Canvas and during the consolidated `beforeunload` flush.

The split-group separator is the single visual boundary between groups, with an 8px pointer target overlaid symmetrically around a 1px rule so the hit area does not create a visible gap between tab strips; focused groups do not add a second perimeter ring. Pointer movement is tracked on `window` until pointer up or cancellation, so dragging either direction remains continuous after the pointer leaves the narrow separator.

Node creation keeps spatial placement separate from presentation. Explicit `user-created` Note/Text placement (for example the Canvas toolbar) requests immediate editing, and toolbar Question placement enters compose through its dedicated flow. Content-derived creation (`user-excerpt`, `user-from-chat`, uploads, and imports) creates and selects its Canvas node without opening or replacing a Preview Workspace tab, so repeated extraction remains continuous.

Local HTML Web Nodes carrying `data.interactiveView` mount as Interactive Views through a dedicated renderer route whose CSP permits only self-contained inline/data/blob content and denies network connections, form submission, nested frames, workers, objects, and external navigation. `WebPreview` removes `allow-same-origin`, keeps only script/form sandbox capabilities, transfers one Host-owned `MessagePort` on the expected document load, and closes rather than reconnecting if that document navigates itself; all later iframe intents use the port. `useInteractiveViewBridge` loads persisted state and typed binding snapshots, rejects oversized, replayed, or excessive requests, dispatches only declared actions, performs native Node/thread navigation against Host-derived binding references, and closes the port, focus listener, and polling timer on unmount or mode change. Binding refresh runs only while mounted and visible. The iframe receives no token, cookie, API route, Host DOM, Electron bridge, or arbitrary query capability.

Each Chat renderer receives a required `ChatSession` and owning workspace tab ID from `PreviewRenderer`; there is no globally current Chat thread or Question replay pointer. Messages, drafts, loading, binding, model settings, pending attachments, and mutable compose mode live on `threadsById[threadId]`; `threadMap` stores only each Canvas's canonical unbound Chat seed. History and stream hooks validate that their owning tab still presents the same target before applying delayed work. An authored Question node's agent mode remains authoritative for replay and follow-up turns.

---

## 5. Internationalisation

The web app uses [`i18next`](../../apps/web/src/i18n/index.ts) with
`react-i18next` for React components.

- Initialise i18n once from [`main.tsx`](../../apps/web/src/main.tsx) by
  importing `apps/web/src/i18n`.
- Locale resources live under
  [`apps/web/src/i18n/resources`](../../apps/web/src/i18n/resources). Keep
  user-facing UI copy in translation files rather than inline strings.
- React components should call `useTranslation()` and pass translated strings
  into common components (`Button.title`, `Loading.message`, `Modal.title`,
  etc.).
- Non-React code may import the shared `i18n` instance and call `i18n.t(...)`
  for user-facing copy (for example toast messages emitted from stores).
- Shared package constants remain token/fallback oriented. Web helpers such as
  [`translateColorOptions`](../../apps/web/src/i18n/colors.ts) map stable
  shared tokens to localised labels at the UI boundary.
- Server API errors expose stable `code` values and English `message`
  fallbacks. Client UI should branch on the code and localise the displayed
  copy; show the server message only as a fallback for unknown errors.
- Date/number formatting should use `i18n.language` rather than the implicit
  browser default when the formatted value is part of translated UI.

`i18next-icu` is intentionally not part of the baseline. Use i18next's built-in
plural suffixes (`key_one`, `key_other`) for simple counts; add ICU only if the
product starts relying on complex plural/select/date message patterns.

---

## 6. Node & edge stacking (z-order)

The **Layers panel order = the `nodes` array order = the sole stacking
authority.** Later in the array ⇒ painted on top. A plain node ordered after a
frame covers that frame **and its entire subtree**; ordered before, it is
covered by the whole subtree.

React Flow's default `zIndexMode: 'auto'` does **not** honour this: it forces
every child above its parent and lifts framed top-level frames by a fixed band,
so a framed subtree always floats above unframed siblings regardless of order.
To make array order authoritative we render with
[`<ReactFlow zIndexMode="manual">`](../../apps/web/src/components/Panels/Canvas/Canvas.tsx)
and derive every `zIndex` ourselves in the **render layer**:

- [`assignNodeZIndices`](../../packages/shared/src/canvas-engine/container/zorder.ts)
  — a depth-first walk of the parent/child forest (parents before children,
  siblings in array order) assigns each node a contiguous z. Children land
  immediately above their frame; a later sibling out-ranks the whole preceding
  subtree.
- [`edgeZIndex`](../../packages/shared/src/canvas-engine/container/zorder.ts) — an
  edge floats at the z of its highest **framed** endpoint (0 when both endpoints
  are top-level), mirroring React Flow's old auto-mode edge behaviour, which
  manual mode otherwise drops. `Canvas.tsx` writes this onto `edge.zIndex`; the
  label portal reuses it via
  [`getEdgeRenderZ`](../../apps/web/src/components/Panels/Canvas/edges/edgeZ.ts).

These are derived at render only. The engine's legacy `zIndex: -1` writes on
framed children are now harmless vestigial values (the render layer overrides
them), so **persistence, diff/delta, the server executor, and realtime sync are
untouched.** The z-wrapping in `Canvas.tsx` is cached by source-node/edge ref so
selection toggles don't break xyflow's per-element `React.memo`.

---

## 7. Related docs

Canvas pan and zoom are local UI state rather than canvas topology. [`canvasStore`](../../apps/web/src/store/canvasStore.ts) records the last viewport under a canvas-specific `localStorage` key, allowing both browser and Electron users to reopen a canvas at the previous view without creating server writes or sharing a viewport across devices. The write is debounced so a per-frame animation persists once; reads and canvas switches flush any pending write first.

Layout-driven Canvas resizes preserve the flow-space point at the centre of the visible Canvas and preserve zoom. Opening or closing Chat commits the final flex widths immediately, so Canvas observes one final resize and computes one centre compensation; the fixed-width Chat content and React Flow viewport then animate their compositor transforms together to that layout without producing intermediate Canvas widths. Both are promoted for transform compositing only while that motion runs — the promotion flag is committed one frame before the transform changes, so the animation still starts on an existing layer, while the unbounded React Flow viewport is never left composited for the Canvas lifetime (which strands stale or never-rastered tiles until an unrelated repaint). Programmatic composer focus uses `preventScroll` because the input is still translated outside the viewport at the start of the opening transition; allowing browser focus scrolling would shift the overflow-hidden layout root by one panel width. Manual panel resizing, Layers, and split preview changes continue to expand or contract the visible area around the current viewpoint instead of keeping one screen edge fixed. Replace previews freeze the hidden zero-width Canvas viewport, and sub-pixel corrections are dropped rather than persisted. When opening a split node or opening Chat from a canvas node, the initiating node becomes a temporary layout anchor: after centre compensation, Canvas applies only the minimum additional pan needed to place its bounds inside a 24px safe area, without zooming. The Canvas keeps one stable resize observer and reads the current anchor inside its callback, combining centre preservation and anchor reveal into one viewport write even when the panel and anchor state change together. That temporary Chat anchor expires on a fixed timer that outlives the panel transition, so it is discarded even when opening Chat changed no layout and cannot affect a later, unrelated resize; ordinary Chat toggles never derive an anchor from historical selection. Explicit navigation through node references, Layers, or search remains separate and may centre its requested target.

- [canvas-command-architecture.md](./canvas-command-architecture.md) — the command/engine model (shared, server + web).
- [agent-context.md](./agent-context.md) — how the web assembles agent context.
- [api-design.md](./api-design.md) — HTTP/SSE contract rules the `api/` clients follow.

Viewport resize and reveal geometry lives in [`focusNodesOnCanvas.ts`](../../apps/web/src/components/Panels/CanvasLayerPanel/focusNodesOnCanvas.ts); [`Canvas.tsx`](../../apps/web/src/components/Panels/Canvas/Canvas.tsx) applies it through a `ResizeObserver`, and [`panelStore.ts`](../../apps/web/src/store/panelStore.ts) carries the one-shot Chat node anchor.

---

## 8. External user handbook

The web application does not contain handbook pages, assets, or a `/docs/*` route. Product actions call the leaf-level [`openUserHandbook()` helper](../../apps/web/src/config/handbook.ts), which validates an absolute URL and opens it in a separate browser context.

Production requires `VITE_HANDBOOK_URL`; the checked-in [`apps/web/.env.production`](../../apps/web/.env.production) supplies the Microsoft Huabu Pages URL, and deployment environments may override it. `pnpm dev` and `pnpm dev:desktop` use that public handbook by default and honor a `VITE_HANDBOOK_URL` override, such as a separately running Huabu repository handbook on localhost. Other development entry points resolve `/docs/` against the current page origin when the variable is unset. Production accepts HTTPS only, while development also accepts HTTP on loopback hosts. Electron continues to deny renderer child windows and sends HTTP(S) targets to the operating system through its existing `setWindowOpenHandler` in [`apps/desktop/src/main.ts`](../../apps/desktop/src/main.ts).

The handbook is owned, built, and deployed from the public [microsoft/Huabu repository](https://github.com/microsoft/Huabu/tree/main/apps/docs); Huabu does not carry a second user-handbook application.

`pnpm start:web` serves the compiled SPA and API from one production-style Fastify process. Before importing the Server bundle, its launcher selects the first available port at or above `SERVER_PORT`/`PORT` (default 3001) and writes the resolved value to `SERVER_PORT`; the shared port probe also protects `dev` and `dev:desktop` from loopback-versus-wildcard binding conflicts.

Network deployment follows the single-owner boundary in [`deployment-security.md`](./deployment-security.md). Non-loopback `start:web` binds fail closed unless allowed hosts and complete Basic Auth are configured. Vite keeps zero-configuration loopback development but rejects non-loopback clients before serving assets or proxying APIs unless they pass the same Basic Auth gate. Settings reads the redacted deployment readiness endpoint and disables credential mutations when the standalone secret store is read-only.

## 9. Desktop troubleshooting actions

The packaged desktop app exposes three support actions without granting the renderer general filesystem or Electron access: reveal the canonical Server log, open Chromium Developer Tools, and copy non-sensitive system information (Huabu version, OS release, CPU architecture, and Electron version). The sandboxed preload bridge exposes only these fixed operations under `electronBridge.diagnostics`; filesystem paths and shell calls remain in the main process. Packaged builds resolve the log below Electron's `userData/data`; `dev:desktop` passes the source Server's `apps/server/data` location to both processes through `HUABU_DATA_DIR`, so the same action always reveals the log written by the active Server.

The Electron-owned `userData` tree (Chromium storage and Electron's own logs / crash dumps) is partitioned by `app.setName`, keyed off whether `EXTERNAL_SERVER_URL` is set (the signal that `scripts/dev-desktop.mjs`'s HMR orchestrator is driving this run): `dev:desktop` anchors on `Huabu Dev` to isolate its actively-changing tsx-watch/Vite code from real user state, while both a packaged install and `pnpm start:desktop` (an unpackaged run of the exact production bundle, used as a pre-release smoke test) anchor on `Huabu` and intentionally share the same on-disk state. The Server data dir follows separately — `start:desktop` derives it from `<userData>/data` (inheriting `Huabu`), while `dev:desktop` overrides it to the in-repo `apps/server/data`. Workspace membership, restore state, and MRU ordering live in the Server-owned `<dataDir>/storage/disk/workspaces.json`. The former port-agnostic `<userData>/workspace.json` is deprecated and read only as a one-time upgrade source when the new registry does not yet exist. Credentials are not affected by this name split: only `start:desktop` / packaged installs use the `safeStorage`-backed `<userData>/data/secure-secrets.json` (and both resolve to `Huabu`, so they share it), whereas `dev:desktop` skips `safeStorage` entirely and persists secrets to `apps/server/data/encrypted-secrets.json` via `HUABU_SECRET_KEY`.

The native macOS Help menu and the Windows/Linux in-app application menu reuse the fixed operations exported by [`useElectron.ts`](../../apps/web/src/hooks/useElectron.ts) and add localized feedback at the UI boundary. On Windows and Linux, Troubleshooting is a side-opening submenu composed from the shared `DropdownMenu` primitives rather than a flat group of support actions. The browser build omits the actions because the diagnostics bridge is absent.

## Code entry points

| File/dir                                                                                                                               | Responsibility                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`apps/web/src/App.tsx`](../../apps/web/src/App.tsx)                                                                                   | Product router; deliberately has no handbook route.                                            |
| [`apps/web/src/config/handbook.ts`](../../apps/web/src/config/handbook.ts)                                                             | Validate and open the canonical external handbook URL.                                         |
| [`apps/web/src/hooks/useElectron.ts`](../../apps/web/src/hooks/useElectron.ts)                                                         | Typed Electron bridge access, fixed support operations, and copied system-information format.  |
| [`apps/web/src/store/conversationOwner.ts`](../../apps/web/src/store/conversationOwner.ts)                                             | Generic presentation-anchor/conversation-owner routing and owner-aware lifecycle writes.       |
| [`apps/web/src/store/previewWorkspace/`](../../apps/web/src/store/previewWorkspace)                                                    | Per-Canvas tab/group topology, persistence, target actions, MRU protection, and selectors.     |
| [`apps/web/src/components/Panels/PreviewWorkspace/`](../../apps/web/src/components/Panels/PreviewWorkspace)                            | Tab strips, groups, split interaction, drag/drop, and target-to-renderer dispatch.             |
| [`apps/web/src/hooks/useChatSession.ts`](../../apps/web/src/hooks/useChatSession.ts)                                                   | Required renderer-local Chat thread and conversation-owner address.                            |
| [`apps/web/src/components/Common/Toast.tsx`](../../apps/web/src/components/Common/Toast.tsx)                                           | Global toast state, tone-specific presentation, duration defaults, and dismissal.              |
| [`apps/web/src/components/Panels/ExpandedNodePanel/`](../../apps/web/src/components/Panels/ExpandedNodePanel)                          | Expanded content rendering and edge-connected node navigation.                                 |
| [`apps/web/src/components/Nodes/web/useInteractiveViewBridge.ts`](../../apps/web/src/components/Nodes/web/useInteractiveViewBridge.ts) | Sandboxed Interactive View MessagePort, action grants, binding refresh, and native navigation. |
| [`apps/desktop/src/preload.ts`](../../apps/desktop/src/preload.ts)                                                                     | Narrow sandbox bridge for native menu and diagnostics operations.                              |
| [`apps/desktop/src/main.ts`](../../apps/desktop/src/main.ts)                                                                           | Electron window security, external URLs, and fixed diagnostics IPC handlers.                   |
| [`scripts/start-web.mjs`](../../scripts/start-web.mjs)                                                                                 | Production-style web launcher and dynamic Server port selection.                               |
| [`scripts/dev-ports.mjs`](../../scripts/dev-ports.mjs)                                                                                 | Shared loopback/wildcard-aware development port selection.                                     |
