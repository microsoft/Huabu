# Web App Architecture (`apps/web/src/`)

> Structure, dependency rules, and conventions for the frontend. The point of
> this doc is the **layering rules** below — not an exhaustive file listing
> (those rot fast; `ls` the dir for the current files).
> Last updated: 2026-07-23

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
├── handler/       # Pure processing logic, no React: canvasCommand/, sketch/, snap/, pdfHighlight/
├── hooks/         # Shared React hooks
├── store/         # Zustand global state
├── api/           # Backend API clients (one file per endpoint group)
├── i18n/          # i18next setup, locale resources, and translation helpers
├── config/        # Static config, constants, and validated external handbook URL
└── utils/         # Generic utilities (non-React)
```

---

## 2. Dependency rules (the important part)

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

## Workspace routes and World

`/` is the workspace landing redirect. When the persisted World setting is enabled it redirects to the hidden World through `/canvas/:worldCanvasId`; otherwise it redirects to `/spaces`. The ordinary Space List remains a sibling page at `/spaces`, and every Canvas scope, including World, continues to use the existing `CanvasPage` and `/canvas/:canvasId` route.

The World setting defaults to disabled. Enabling it exposes the World navigation entry and changes subsequent workspace landing to World without deleting or resetting `.world`.

`CanvasRefNode` renders a canonical Portal from persisted `targetCanvasId` plus one batched ordinary-Space title map loaded when World opens. Portal activation uses double-click, Enter while selected, or its Open action. A missing title after the Space list has loaded is rendered as an explicit broken reference; transient source titles are never persisted into World topology.

`FrameRefNode` and `NodeRefNode` keep persistent target identity separate from a runtime `worldReferences` map populated by the batch reference endpoint. A `frameRef` renders as a World Container around its recursively pinned snapshot descendants; a `nodeRef` renders the referenced leaf card. The resolved source projection includes label/type/summary/preview/revision and, for question nodes, thread/lifecycle/mode/binding fields. References render source details or an explicit missing-Space/missing-node placeholder and refresh on World load, shortcut open, window focus, headless turn start/end, and active-World Pin/Unpin completion. Source-Space single/multi-selection toolbars expose explicit Pin and Unpin actions, while World selections expose Unpin for selected reference entries. These actions drain pending, in-flight, and coalesced structure writes before calling the server command boundary and never construct positions, hierarchy, or references in web state.

Opening a resolved question `nodeRef` leaves World as the active Canvas and points the ordinary single ChatPanel at an `AgentConversationView`: the World `nodeRef` is the presentation anchor while the source question Canvas/node/thread is the conversation owner. Owner-aware helpers route history, reconnect, agent streams, lifecycle mutations, binding/mode, and change-record loads to the source. Headless turns send no World selection. Source changes are not previewed against World; the review notice opens the source Space and restores the same conversation there.

The web keeps undo/redo managers in a registry keyed by `canvasId` while retaining one active Canvas store. Switching between World and a Space activates the target manager instead of clearing the scope being left; an authoritative reload of the already-active Canvas still clears that Canvas's stale history. First-version Pin/Unpin does not create a snapshot entry: any actual `frameRef` / `nodeRef` membership or hierarchy change, including recursive adoption or removal with a broken Portal subtree, clears the corresponding World manager because the protected identities cannot be recreated through legacy full-state restore. A routed mutation received while a source Space is active leaves that Space's independent history unchanged.

The keyboard shortcut catalog may retain internal runtime bindings with `hidden: true`; `getKeyboardShortcutSections()` excludes them from the user-facing modal. Removed bindings must be deleted from the catalog rather than left as display-only entries.

The Expanded Node Panel derives upstream and downstream navigation from the active Canvas edges without adding persisted navigation state: incoming-edge sources are upstream, outgoing-edge targets are downstream, and neighbors follow Canvas node order after missing endpoints, self-loops, and duplicates are removed. Bare Left/Right Arrow actions switch directly when one neighbor exists or open a deterministic chooser when several exist. Editable controls, search, menus, media controls, and embedded viewers retain arrow-key ownership. Switching reuses `openExpanded`, replaces the Canvas selection with the destination node, preserves split/replace mode, and does not pan or zoom to reveal the destination.

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

Canvas pan and zoom are local UI state rather than canvas topology. [`canvasStore`](../../apps/web/src/store/canvasStore.ts) records the last viewport under a canvas-specific `localStorage` key, allowing both browser and Electron users to reopen a canvas at the previous view without creating server writes or sharing a viewport across devices.

- [canvas-command-architecture.md](./canvas-command-architecture.md) — the command/engine model (shared, server + web).
- [agent-context.md](./agent-context.md) — how the web assembles agent context.
- [api-design.md](./api-design.md) — HTTP/SSE contract rules the `api/` clients follow.

---

## 8. External user handbook

The web application does not contain handbook pages, assets, or a `/docs/*` route. Product actions call the leaf-level [`openUserHandbook()` helper](../../apps/web/src/config/handbook.ts), which validates an absolute URL and opens it in a separate browser context.

Production requires `VITE_HANDBOOK_URL`; the checked-in [`apps/web/.env.production`](../../apps/web/.env.production) supplies the Microsoft Huabu Pages URL, and deployment environments may override it. `pnpm dev` and `pnpm dev:desktop` use that public handbook by default and honor a `VITE_HANDBOOK_URL` override, such as a separately running Huabu repository handbook on localhost. Other development entry points resolve `/docs/` against the current page origin when the variable is unset. Production accepts HTTPS only, while development also accepts HTTP on loopback hosts. Electron continues to deny renderer child windows and sends HTTP(S) targets to the operating system through its existing `setWindowOpenHandler` in [`apps/desktop/src/main.ts`](../../apps/desktop/src/main.ts).

The handbook is owned, built, and deployed from the public [microsoft/Huabu repository](https://github.com/microsoft/Huabu/tree/main/apps/docs); Sediment does not carry a second user-handbook application.

`pnpm start:web` serves the compiled SPA and API from one production-style Fastify process. Before importing the Server bundle, its launcher selects the first available port at or above `SERVER_PORT`/`PORT` (default 3001) and writes the resolved value to `SERVER_PORT`; the shared port probe also protects `dev` and `dev:desktop` from loopback-versus-wildcard binding conflicts.

## 9. Desktop troubleshooting actions

The packaged desktop app exposes three support actions without granting the renderer general filesystem or Electron access: reveal the canonical Server log, open Chromium Developer Tools, and copy non-sensitive system information (Huabu version, OS release, CPU architecture, and Electron version). The sandboxed preload bridge exposes only these fixed operations under `electronBridge.diagnostics`; filesystem paths and shell calls remain in the main process. Packaged builds resolve the log below Electron's `userData/data`; `dev:desktop` passes the source Server's `apps/server/data` location to both processes through `HUABU_DATA_DIR`, so the same action always reveals the log written by the active Server.

The Electron-owned `userData` tree (the port-agnostic `workspace.json`, Chromium storage, and Electron's own logs / crash dumps) is partitioned by `app.setName`, keyed off whether `EXTERNAL_SERVER_URL` is set (the signal that `scripts/dev-desktop.mjs`'s HMR orchestrator is driving this run): `dev:desktop` anchors on `Huabu Dev` to isolate its actively-changing tsx-watch/Vite code from real user state, while both a packaged install and `pnpm start:desktop` (an unpackaged run of the exact production bundle, used as a pre-release smoke test) anchor on `Huabu` and intentionally share the same on-disk state. The Server data dir follows separately — `start:desktop` derives it from `<userData>/data` (inheriting `Huabu`), while `dev:desktop` overrides it to the in-repo `apps/server/data`. Credentials are not affected by this name split: only `start:desktop` / packaged installs use the `safeStorage`-backed `<userData>/data/secure-secrets.json` (and both resolve to `Huabu`, so they share it), whereas `dev:desktop` skips `safeStorage` entirely and persists secrets to `apps/server/data/encrypted-secrets.json` via `HUABU_SECRET_KEY`.

The native macOS Help menu and the Windows/Linux in-app application menu reuse the fixed operations exported by [`useElectron.ts`](../../apps/web/src/hooks/useElectron.ts) and add localized feedback at the UI boundary. On Windows and Linux, Troubleshooting is a side-opening submenu composed from the shared `DropdownMenu` primitives rather than a flat group of support actions. The browser build omits the actions because the diagnostics bridge is absent.

## Code entry points

| File/dir                                                                                                      | Responsibility                                                                                |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`apps/web/src/App.tsx`](../../apps/web/src/App.tsx)                                                          | Product router; deliberately has no handbook route.                                           |
| [`apps/web/src/config/handbook.ts`](../../apps/web/src/config/handbook.ts)                                    | Validate and open the canonical external handbook URL.                                        |
| [`apps/web/src/hooks/useElectron.ts`](../../apps/web/src/hooks/useElectron.ts)                                | Typed Electron bridge access, fixed support operations, and copied system-information format. |
| [`apps/web/src/store/conversationOwner.ts`](../../apps/web/src/store/conversationOwner.ts)                    | Generic presentation-anchor/conversation-owner routing and owner-aware lifecycle writes.      |
| [`apps/web/src/components/Panels/ExpandedNodePanel/`](../../apps/web/src/components/Panels/ExpandedNodePanel) | Expanded content rendering and edge-connected node navigation.                                |
| [`apps/desktop/src/preload.ts`](../../apps/desktop/src/preload.ts)                                            | Narrow sandbox bridge for native menu and diagnostics operations.                             |
| [`apps/desktop/src/main.ts`](../../apps/desktop/src/main.ts)                                                  | Electron window security, external URLs, and fixed diagnostics IPC handlers.                  |
| [`scripts/start-web.mjs`](../../scripts/start-web.mjs)                                                        | Production-style web launcher and dynamic Server port selection.                              |
| [`scripts/dev-ports.mjs`](../../scripts/dev-ports.mjs)                                                        | Shared loopback/wildcard-aware development port selection.                                    |
