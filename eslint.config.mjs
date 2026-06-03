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

export default typescriptEslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.vite/**',
      '**/*.min.*',
      // Vendored upstream code — lint with its own rules in the agentlet repo.
      'external/**',
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
          './apps/web/tsconfig.json',
          './apps/web/tsconfig.node.json',
          './packages/shared/tsconfig.json',
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
            './apps/web/tsconfig.json',
            './packages/shared/tsconfig.json',
          ],
        },
      },
    },
    rules: {
      curly: 'error',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn',
      semi: 'error',
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
            { pattern: '@sediment/**', group: 'external', position: 'after' },
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
      'packages/shared/src/**/*.{ts,tsx}',
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
    // @sediment/shared boundary: the shared package is server-portable
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
                '@sediment/shared is server-portable. Use `import type` for Node/Edge shapes only.',
              allowTypeImports: true,
            },
          ],
          patterns: [
            {
              group: ['@/*'],
              message:
                '@sediment/shared has no @/ alias. Use relative imports inside the package.',
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
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Keep zod (and any future runtime dep of @sediment/shared) out of
      // the web bundle. Schemas may only be imported as `import type`
      // from web code — see docs/api-design.md §Rules #5.
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
