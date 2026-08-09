// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import js from '@eslint/js';
import globals from 'globals';
import importPlugin from 'eslint-plugin-import';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import eslintConfigPrettier from 'eslint-config-prettier';
import typescriptEslint from 'typescript-eslint';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// jsx-a11y's default handler list includes `onError` / `onLoad`, which are
// resource lifecycle events (image fallbacks, iframe spinners) rather than
// interactions, so they must not make an element "interactive".
const A11Y_INTERACTION_HANDLERS = [
  'onClick',
  'onMouseDown',
  'onMouseUp',
  'onKeyPress',
  'onKeyDown',
  'onKeyUp',
];

export default typescriptEslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-bundle/**',
      '**/dist-electron/**',
      '**/out/**',
      '**/.vite/**',
      '**/.ssr/**',
      '**/*.min.*',
      // Vendored upstream code — lint with its own rules in the agentlet repo.
      // NOTE: external/agenetes is authored by us and IS linted with the
      // repo's rules (see the TS project list + Node env block below); only
      // the vendored agentlet subtree is ignored here.
      'external/agentlet/**',
      // Agent Team packages are self-contained plugins with their own
      // scripts/prompts; not part of the app's lint surface.
      'agent-teams/**',
    ],
  },
  js.configs.recommended,
  ...typescriptEslint.configs.recommended,
  {
    // General TS rules for all TS files
    files: ['**/*.{ts,tsx}'],
    plugins: {
      import: importPlugin,
    },
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.base.json',
          './apps/server/tsconfig.json',
          './apps/desktop/tsconfig.json',
          './apps/web/tsconfig.json',
          './apps/web/tsconfig.node.json',
          './apps/docs/tsconfig.json',
          './apps/docs/tsconfig.node.json',
          './packages/shared/tsconfig.json',
          './external/agenetes/packages/protocol/tsconfig.json',
          './external/agenetes/packages/runtime/tsconfig.json',
        ],
        tsconfigRootDir: __dirname,
      },
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: [
            './tsconfig.base.json',
            './apps/server/tsconfig.json',
            './apps/desktop/tsconfig.json',
            './apps/web/tsconfig.json',
            './apps/docs/tsconfig.json',
            './packages/shared/tsconfig.json',
            './external/agenetes/packages/protocol/tsconfig.json',
            './external/agenetes/packages/runtime/tsconfig.json',
          ],
        },
      },
    },
    rules: {
      curly: 'error',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn',
      semi: 'error',
      // Layer seam boundaries (L1 Huabu / L2 Agenetes / L3 plugins) —
      // docs/proposals/layered-architecture.md §5. Enforce only the
      // dependency arrows that already hold physically today; the
      // L1↔L2-*internal* boundary is deferred until modules/agent is
      // physically extracted (§7 M5/M6), because L1 and L2 still share
      // the apps/server process for now.
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              // L1 web client ↛ L2/host server runtime. The only legal
              // channel is HTTP/SSE + shared wire types.
              target: './apps/web/src',
              from: './apps/server/src',
              message:
                'L1 (web client) must not import L2/host server code. Cross the seam via HTTP/SSE and shared wire types in packages/shared. See docs/proposals/layered-architecture.md §5.',
            },
            {
              // The shared contract package is the seam vocabulary and
              // must stay app-independent (no cycles, server-portable).
              target: './packages/shared/src',
              from: './apps',
              message:
                'The shared contract package must not depend on any app. Move the shared type/logic into packages/shared instead. See docs/architecture/api-design.md.',
            },
          ],
        },
      ],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'import/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling'],
            'index',
            'type',
          ],
          // Explicitly classify workspace aliases so ordering does not
          // depend on the resolver successfully resolving them. Without
          // this, `eslint-import-resolver-typescript` version drift or
          // cache state can cause different machines to bucket `@/...`
          // into different groups, producing diverging lint:fix output.
          pathGroups: [
            { pattern: '@huabu/**', group: 'external', position: 'after' },
            { pattern: '@/**', group: 'internal', position: 'before' },
          ],
          pathGroupsExcludedImportTypes: ['type'],
          distinctGroup: true,
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],
    },
  },
  {
    // Node.js Env (Server & Shared)
    files: [
      'apps/server/src/**/*.{ts,tsx}',
      'apps/server/src/**/*.{js,mjs,cjs}',
      'apps/desktop/src/**/*.{ts,tsx}',
      'apps/*/scripts/**/*.{js,mjs,cjs}',
      'packages/shared/src/**/*.{ts,tsx}',
      'external/agenetes/packages/*/src/**/*.{ts,tsx}',
      'vite.config.ts',
      '*.config.js',
      '*.config.mjs',
      'scripts/**/*.{js,mjs,cjs}',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Server logging discipline: every service / route / utility must
    // emit through the shared pino logger (see
    // apps/server/src/utils/logger.ts → getLogger). Direct `console.*`
    // calls bypass level filtering, structured fields, redaction, and
    // the on-disk log file — so they're banned across the server.
    //
    // One narrow exception, configured below:
    //   • apps/server/src/utils/logger.ts — the logger module itself
    //     may need to fall back to console during its own
    //     initialization failure paths.
    files: ['apps/server/src/**/*.{ts,tsx,js,mjs,cjs}'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['apps/server/src/utils/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // @huabu/shared boundary: the shared package is server-portable
    // and must not pull in browser-only runtime deps. `@xyflow/react`
    // types are allowed (Node/Edge shapes), but the runtime entry is
    // banned. Web-side aliases (`@/`) are also disallowed here because
    // shared has no `paths` mapping.
    files: ['packages/shared/src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@xyflow/react',
              message:
                '@huabu/shared is server-portable. Use `import type` for Node/Edge shapes only.',
              allowTypeImports: true,
            },
          ],
          patterns: [
            {
              group: ['@/*'],
              message:
                '@huabu/shared has no @/ alias. Use relative imports inside the package.',
            },
          ],
        },
      ],
    },
  },
  {
    // Browser Env (Web App)
    files: ['apps/web/src/**/*.{ts,tsx,js,jsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11yPlugin,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // Accessibility linting for JSX (eslint-plugin-jsx-a11y).
      ...jsxA11yPlugin.flatConfigs.recommended.rules,
      'jsx-a11y/no-static-element-interactions': [
        'error',
        { handlers: A11Y_INTERACTION_HANDLERS },
      ],
      'jsx-a11y/no-noninteractive-element-interactions': [
        'error',
        { handlers: A11Y_INTERACTION_HANDLERS },
      ],
      // A focusable `separator` is the ARIA window-splitter pattern: a pane
      // divider the user can move with the keyboard, carrying
      // `aria-valuenow` / `aria-valuemin` / `aria-valuemax`. The rule treats
      // `separator` as non-interactive regardless of whether it is focusable,
      // so it is added alongside the default `tabpanel` exemption.
      'jsx-a11y/no-noninteractive-tabindex': [
        'error',
        { tags: [], roles: ['tabpanel', 'separator'] },
      ],
      // Only flag `autoFocus` on real DOM elements — the prop's meaning on
      // our own components (Button, TextInput, DropdownMenuItem) is theirs
      // to define.
      'jsx-a11y/no-autofocus': ['error', { ignoreNonDOM: true }],
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Keep zod (and any future runtime dep of @huabu/shared) out of
      // the web bundle. Schemas may only be imported as `import type`
      // from web code — see docs/architecture/api-design.md §Rules #5.
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    // Milkdown boundary: only files under `components/Milkdown/` may
    // import `@milkdown/*`, `prosemirror-*`, or `katex` directly. Every
    // other web file must go through the wrapper (createMilkdown /
    // MilkdownPreview / MilkdownMessageCard) so we can swap or upgrade
    // the editor without touching feature code. See
    // docs/milkdown-migration-plan.md §1b.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/components/Milkdown/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@milkdown/*', 'prosemirror-*', 'katex', 'katex/*'],
              message:
                'Import Milkdown / ProseMirror / KaTeX only from components/Milkdown/. Use the wrapper (createMilkdown, MilkdownPreview, MilkdownMessageCard) instead.',
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
