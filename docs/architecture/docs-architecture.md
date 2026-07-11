# Standalone User Handbook Architecture

> Current-state reference for `apps/docs`. Last updated: 2026-07-11.

## Boundary

The public Huabu user handbook is an independent Vite workspace application under [`apps/docs`](../../apps/docs). It imports no source from `apps/web`, `apps/desktop`, or `apps/server`; handbook content, icons, styles, and public assets are owned by the documentation app.

The product web app has no `/docs/*` route. Its translated handbook actions call the validated external URL helper described in [web-architecture.md](./web-architecture.md#8-external-user-handbook).

## Layout

```text
apps/docs/
├── public/                 # Documentation-owned favicons and screenshots
├── scripts/
│   ├── prerender.mjs       # Static HTML generation from the SSR bundle
│   └── validate-build.mjs  # Deployable-artifact integrity checks
├── src/
│   ├── components/         # Handbook-only presentation and Pagefind UI
│   ├── config/             # Local icons and English shortcut content
│   ├── sections/           # User handbook articles
│   ├── navigation.ts       # Routes, loaders, titles, and descriptions
│   ├── main.tsx            # Browser hydration
│   └── entry-server.tsx    # Build-time streaming SSR
└── dist/                   # Complete deployable Pages artifact
```

## URL and routing model

Every public article path remains under `/docs`, while Vite's normalized `DOCS_BASE_PATH` supplies the deployment prefix. A project Pages build therefore serves `/Sediment/docs/quickstart/`, while a custom-domain build can serve `/docs/quickstart/`.

The browser uses `BrowserRouter`; prerendering uses `StaticRouter` with the same basename. [`navigation.ts`](../../apps/docs/src/navigation.ts) is the sole route registry and includes path, lazy section loader, title, and description. It also fails module initialization on duplicate paths. Unknown paths render a handbook-specific not-found page.

Public asset URLs pass through the base-path helper. The Pages artifact root contains a static base-aware redirect to `docs/`; this redirect belongs to the handbook artifact and is not present in the product application.

## Static build

```text
TypeScript check
      ↓
Vite client build + manifest
      ↓
Vite Node SSR bundle
      ↓
renderToPipeableStream(onAllReady) for every registered route
      ↓
Pagefind article indexing
      ↓
artifact validation
```

The server entry waits for `onAllReady`, so lazy sections resolve before HTML is written. The prerender script writes directory-style route files and route-specific title and description metadata, then removes the temporary SSR bundle. There is no production server and no SPA fallback.

Each article carries `data-pagefind-body`, excluding repeated navigation and table-of-contents text from indexing. Opening the sidebar search control or pressing `Ctrl/Cmd+K` displays Pagefind in an accessible modal with backdrop and Escape dismissal, focus containment, and trigger-focus restoration. Search results show compact page-title links followed by matching section-title links that jump directly to their anchors; generated body excerpts are hidden to avoid ambiguous stitched text. Results use a two-column card grid on wider screens and one column on narrow screens, loading ten page results per batch. `@pagefind/default-ui` initializes lazily on the first open in a built site and remains mounted across later opens. The Vite development server displays the modal shell but explicitly reports search as unavailable because it has no current static index.

## Validation and deployment

The artifact validator compares generated pages with the source route registry, verifies article markup, H1 and metadata output, rejects Suspense fallback and forbidden environment values, and requires Pagefind runtime/index files. Source tests cover route uniqueness, metadata completeness, the missing-node-content regression, and base normalization.

The dedicated GitHub Actions workflow builds on pull requests and deploys only [`apps/docs/dist`](../../apps/docs) on `main` or manual dispatch. It derives the repository Pages base from `GITHUB_REPOSITORY` unless the repository variable `DOCS_BASE_PATH` overrides it. The workflow uses GitHub Pages artifact and deployment actions with only `contents: read`, `pages: write`, and `id-token: write`.

## Commands

| Command             | Responsibility                                                 |
| ------------------- | -------------------------------------------------------------- |
| `pnpm dev:docs`     | Run the independent Vite development server on port 5174.      |
| `pnpm test:docs`    | Run handbook source and helper tests.                          |
| `pnpm build:docs`   | Typecheck, build, prerender, index, and validate the artifact. |
| `pnpm preview:docs` | Serve the final static artifact on port 4174.                  |

## Code entry points

| File/dir                                                                             | Responsibility                                        |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| [`apps/docs/src/navigation.ts`](../../apps/docs/src/navigation.ts)                   | Canonical article routes, lazy loaders, and metadata. |
| [`apps/docs/src/main.tsx`](../../apps/docs/src/main.tsx)                             | Hydrate prerendered markup in the browser.            |
| [`apps/docs/src/entry-server.tsx`](../../apps/docs/src/entry-server.tsx)             | Stream complete route markup at build time.           |
| [`apps/docs/scripts/prerender.mjs`](../../apps/docs/scripts/prerender.mjs)           | Write route HTML and the artifact-root redirect.      |
| [`apps/docs/scripts/validate-build.mjs`](../../apps/docs/scripts/validate-build.mjs) | Enforce the static artifact contract.                 |
| [`.github/workflows/docs.yml`](../../.github/workflows/docs.yml)                     | Build, upload, and deploy the Pages artifact.         |
