# Web App Architecture (`apps/web/src/`)

> Structure, dependency rules, and conventions for the frontend. The point of
> this doc is the **layering rules** below — not an exhaustive file listing
> (those rot fast; `ls` the dir for the current files).
> Last updated: 2026-06-30

---

## 1. Top-level layout

```
apps/web/src/
├── App.tsx        # Router + WorkspaceGuard
├── main.tsx       # ReactDOM entry
├── index.css      # Global CSS / design tokens
├── pages/         # Route-level pages & app shell
├── components/    # Reusable UI (no business logic): Common, Nodes, Panels, Messages, Milkdown, CodeMirror, Search
├── handler/       # Pure processing logic, no React: canvasCommand/, sketch/, snap/, pdfHighlight/
├── hooks/         # Shared React hooks
├── store/         # Zustand global state
├── api/           # Backend API clients (one file per endpoint group)
├── config/        # Static config & constants
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
7. **Design tokens only** — never raw hex / Tailwind palette / ShadCN aliases. See [.github/design-system.md](../../.github/design-system.md).

---

## 5. Related docs

- [canvas-command-architecture.md](./canvas-command-architecture.md) — the command/engine model (shared, server + web).
- [agent-context.md](./agent-context.md) — how the web assembles agent context.
- [api-design.md](./api-design.md) — HTTP/SSE contract rules the `api/` clients follow.
