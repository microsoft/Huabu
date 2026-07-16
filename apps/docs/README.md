# Huabu User Handbook

This package contains the source for the public Huabu User Handbook at [https://microsoft.github.io/Huabu/docs/](https://microsoft.github.io/Huabu/docs/). It is an independent Vite application maintained directly in the Huabu repository.

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

The development server defaults to `http://localhost:43127`. Set `DOCS_PORT` to use another port. Search is unavailable in development because Pagefind indexes are generated during the production build.

To preview the complete generated site, including search:

```sh
pnpm build
pnpm preview
```

The preview server defaults to `http://localhost:43128`.

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
