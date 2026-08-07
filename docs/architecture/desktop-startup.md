# Desktop Cold Start

> What the user sees between double-clicking Huabu and the canvas list appearing, and which parts of the system own each phase.
> Last updated: 2026-07-31

---

## 1. The sequence

```
app.whenReady()
  ├─ splash window opens                 ← first thing on screen
  ├─ shell-PATH probe, port allocation
  ├─ server fork + TCP readiness wait
  ├─ main window created (show: false), loadURL(http://127.0.0.1:<port>)
  ├─ renderer parses the entry graph     ← nothing paints during this
  ├─ 'ready-to-show'  → main window shown, splash closed
  └─ renderer: init() → GET /api/workspace → PUT /api/workspace (activation)
                                           ← WorkspaceLoadingScreen covers this
```

When no remembered workspace can be activated, the workspace guard redirects to the stable `/setup` route instead of rendering the setup page inside the guard. This keeps the route that owns the post-activation navigation mounted while `selectWorkspace()` publishes `isReady`; after activation it navigates through `/` to `/spaces` (or World when enabled).

Two independent costs dominate a cold start:

1. **Entry-graph evaluation.** One long synchronous task in the renderer. Its cost is the size of the first-screen JavaScript graph, and it is paid in full on the first launch after an install or an update, when Chromium's per-origin code cache is empty. (It is also paid on _every_ launch when the shell cannot get its preferred port, because the origin — and therefore the cache — changes with the port.)
2. **Workspace activation.** The server always boots with no workspace; the remembered path lives in the main process, so the renderer has to `PUT /api/workspace` after it loads. Activation forks the preparation worker and runs the migration chain over the workspace root, which is sub-second on local disk and seconds on a cloud-sync mount (Google Drive, iCloud, OneDrive).

## 2. Why the splash is a separate window

Nothing served from `index.html` can paint before the entry graph finishes evaluating. Chromium performs no rendering between the end of HTML parsing and the execution of deferred scripts, so a JS splash and a static HTML skeleton behave identically — measured against a deliberately blocking entry, both reported `DOMContentLoaded` at 3.02 s and first paint at 3.84 s. Forcing a frame out earlier would not help either: the animation is driven from the same main thread that is blocked, so it would freeze on one frame.

A second `BrowserWindow` is its own renderer process. Its main thread is free, so the brand animation actually animates, and it can appear before the main window exists at all — covering the server fork and readiness wait as well.

The page is generated rather than committed: [`scripts/build-splash.mjs`](../../apps/desktop/scripts/build-splash.mjs) inlines the Lottie light player and [`apps/web/src/assets/loading.json`](../../apps/web/src/assets/loading.json) into `dist/splash.html` at build time. Inlining keeps it self-contained (there is no server to fetch from yet, and the dev and packaged layouts differ), and generating keeps the brand animation a single source of truth. `dist/**` is already covered by electron-builder's `files`, so packaging needs no extra entry.

The main window is created with `show: false` and revealed on `ready-to-show`, with a timeout fallback and a `did-fail-load` fallback so a wedged or failing renderer can never leave the user with only a splash.

## 3. The first-screen bundle boundary

Everything Vite reaches **statically** from `main.tsx` lands in `index.html` as the entry script plus `modulepreload` links, and all of it must be evaluated before React's first paint. Keeping that set small is the lever on phase 1 above.

Rules that hold today:

- The canvas route is behind `React.lazy`, which is what keeps `vendor-editor`, `vendor-pdf` and `vendor-katex` (~3 MB) off the first screen. `React.lazy` rather than the router's own `lazy` option, so the route element is always defined and the router stays synchronous — otherwise the whole tree, title bar included, waits on route initialisation.
- [`offscreenMeasurer.ts`](../../apps/web/src/components/Nodes/shared/height/measure/offscreenMeasurer.ts) imports Milkdown dynamically. `canvasStore` reaches that file and the app shell reaches `canvasStore`, so a static edge there pulls the entire editor toolchain back into the entry graph.
- Small libraries shared between the shell and the editor (`clsx`, floating-ui, the unified/remark/micromark family) have explicit `manualChunks` homes. A module with no assigned chunk lands in one its importers have in common — in practice `vendor-editor` — and a single symbol is enough to make the 2.3 MB editor bundle a static dependency of the entry. Vite's own dynamic-import preload helper is assigned for the same reason.

Verify after touching any of this by building and reading the emitted `dist/index.html`: the `modulepreload` set is the first-screen graph.

## 4. Code entry points

| File/dir                                                                                                 | Responsibility                                                                         |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [apps/desktop/src/main.ts](../../apps/desktop/src/main.ts)                                               | `createSplashWindow` / `closeSplashWindow`, the `show: false` + `ready-to-show` reveal |
| [apps/desktop/scripts/build-splash.mjs](../../apps/desktop/scripts/build-splash.mjs)                     | Generates the self-contained `dist/splash.html`                                        |
| [apps/web/vite.config.ts](../../apps/web/vite.config.ts)                                                 | `manualChunks` — the vendor chunk boundaries described above                           |
| [apps/web/src/App.tsx](../../apps/web/src/App.tsx)                                                       | Lazy canvas route; workspace bootstrap that drives `WorkspaceLoadingScreen`            |
| [apps/web/src/store/workspaceStore.ts](../../apps/web/src/store/workspaceStore.ts)                       | `init()` — the `GET` / `PUT /api/workspace` bootstrap                                  |
| [apps/server/src/modules/workspace-activation.ts](../../apps/server/src/modules/workspace-activation.ts) | Forked workspace preparation, timeout and in-progress guards                           |
