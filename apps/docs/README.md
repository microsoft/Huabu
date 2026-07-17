# Huabu User Handbook

This package contains the public Huabu website at [https://microsoft.github.io/Huabu/](https://microsoft.github.io/Huabu/). The static landing page is served at the site root, while the Vite-powered User Handbook is served from [`/docs/`](https://microsoft.github.io/Huabu/docs/).

The landing page source lives in `landingpage/`. Its handbook links and local assets are deployment-relative. The production build copies it into the artifact root after prerendering the handbook, replaces explicit metadata placeholders with canonical and social-preview URLs derived from `DOCS_BASE_PATH` and `DOCS_CANONICAL_ORIGIN`, and validates both parts as one deployable site. The social-preview image is stored alongside the landing page source and copied into the artifact rather than loaded from an external host.

## Requirements

- Node.js 22
- pnpm 10.34.3

## Install dependencies

From the repository root, run:

```sh
pnpm install
```

## Local development

Start the Vite development server:

```sh
pnpm dev
```

The development server defaults to `http://localhost:43127`. Set `DOCS_PORT` to use another port. The Vite server serves the handbook directly; open `landingpage/index.html` separately to work on the static landing page. Search is unavailable in development because Pagefind indexes are generated during the production build.

To preview the complete generated site, including search:

```sh
pnpm build
pnpm preview
```

The preview server defaults to `http://localhost:43128`. The landing page is available at the server root, and the handbook is available at `http://localhost:43128/docs/`. The preview server runs in multi-page mode so each prerendered handbook route serves its own generated HTML instead of falling back to the landing page.

## Quality checks

Run the complete repository quality gate from the repository root before opening a pull request:

```sh
pnpm check
```

The root command runs these checks across every workspace package in order:

- `pnpm lint` — applies the repository ESLint rules to all supported source files.
- `pnpm format:check` — verifies repository-wide Prettier formatting without modifying files.
- `pnpm typecheck` — runs each workspace package's type checker when present.
- `pnpm test` — runs each workspace package's test suite when present.
- `pnpm build` — builds each workspace package when present; for this package it also prerenders, indexes, and validates the deployable static artifact.
- `node scripts/check-headers.mjs` — verifies Microsoft MIT headers across tracked source files.

To apply safe automatic lint and formatting fixes:

```sh
pnpm lint:fix
pnpm format
```

Review automatic changes before committing them.

## Tests

Run all tests once:

```sh
pnpm test
```

Run tests in watch mode while developing:

```sh
pnpm test:watch
```

Tests use Vitest with Happy DOM. Add or update tests when changing routing, navigation, base-path behavior, or documentation data with executable invariants.
