// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { cpSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { defineConfig } from 'tsup';

// ESM bundles don't have `require`, `__dirname`, or `__filename` in
// global scope, but plenty of bundled CJS packages assume they exist:
// dynamic `require('fs')` calls need createRequire, while bundled runtime
// asset lookups need file-relative `__dirname` / `__filename`.
const BANNER = {
  js:
    `import { createRequire as __createRequire } from 'module';\n` +
    `import { fileURLToPath as __fileURLToPath } from 'url';\n` +
    `import { dirname as __pathDirname } from 'path';\n` +
    `const require = __createRequire(import.meta.url);\n` +
    `const __filename = __fileURLToPath(import.meta.url);\n` +
    `const __dirname = __pathDirname(__filename);`,
};

// @resvg/resvg-wasm ships its WebAssembly as `index_bg.wasm`. The agent
// tool `snapshot_nodes` calls `initWasm(readFile('resvg-bg.wasm'))` at
// first use; the fallback path it uses in bundle layout is sibling-of-
// server.js, so copy the file there using pnpm-layout-agnostic resolution.
const resvgWasmSrc = createRequire(path.resolve('package.json')).resolve(
  '@resvg/resvg-wasm/index_bg.wasm',
);

export default defineConfig([
  {
    entry: {
      server: 'src/server.ts',
      'workspace-prepare.worker': 'src/modules/workspace-prepare.worker.ts',
    },
    format: ['esm'],
    outDir: 'dist-bundle',
    bundle: true,
    // Bundle ALL npm packages into a single self-contained file.
    // This means no node_modules directory is needed at runtime — ideal for
    // Electron packaging where shipping 200MB of node_modules is unacceptable.
    //
    // @napi-rs/* packages are kept external because they are native binary
    // addons (.node files) that esbuild cannot process. However, they are only
    // used by `unpdf` for image rendering, which @opendocsg/pdf2md never calls
    // (it only uses text extraction). The missing native module will never be
    // reached at runtime, so no extra packaging of the .node files is needed.
    noExternal: [/.*/],
    external: [/@napi-rs\/.*/],
    splitting: false,
    sourcemap: false,
    // `prebundle` removes the shared output root once before tsup starts.
    // Cleaning here would race the parallel agentlet config below because
    // its output directory is nested under this one.
    clean: false,
    // Target the Node version shipped with Electron 35 (~Node 22)
    target: 'node22',
    // Many bundled CJS packages call require('fs'), require('path'), etc.
    // In an ESM output file, `require` is not defined. This banner injects a
    // real `require` function so those CJS-style dynamic requires work correctly.
    // Using __createRequire alias to avoid conflicts with any bundled source that
    // also imports createRequire (e.g., pdf.loader.ts).
    banner: BANNER,
    esbuildOptions(options) {
      options.platform = 'node';
    },
    // Prompt templates (AGENT.md / SKILL.md / .md fragments) are read off
    // the filesystem at runtime by the prompt loaders. esbuild can't inline
    // them, so copy the entire `src/prompt/` tree next to the bundled
    // `server.js`. The loaders detect this layout via `dist-bundle/prompt/`
    // and switch their resolution root accordingly.
    async onSuccess() {
      const src = path.resolve('src/prompt');
      const dst = path.resolve('dist-bundle/prompt');
      cpSync(src, dst, { recursive: true });
      console.log(`[tsup] copied prompt templates -> ${dst}`);
      const agentTeamsSrc = path.resolve('../../agent-teams');
      const agentTeamsDst = path.resolve('dist-bundle/agent-teams');
      // `deepv-slides-maker` is dev-only and must not ship in production
      // installers. Skip its subtree (and anything under it) while copying
      // the rest of the bundled Agent Team templates.
      const excludedTeamDir = path.join(agentTeamsSrc, 'deepv-slides-maker');
      cpSync(agentTeamsSrc, agentTeamsDst, {
        recursive: true,
        filter: (source) =>
          source !== excludedTeamDir &&
          !source.startsWith(excludedTeamDir + path.sep),
      });
      console.log(`[tsup] copied bundled Agent Teams -> ${agentTeamsDst}`);
      // @resvg/resvg-wasm — copied next to server.js so the
      // snapshot_nodes tool's bundle-layout fallback finds it via
      // bundled server module's file URL.
      const resvgWasmDst = path.resolve('dist-bundle/resvg-bg.wasm');
      cpSync(resvgWasmSrc, resvgWasmDst);
      console.log(`[tsup] copied resvg-bg.wasm -> ${resvgWasmDst}`);
    },
  },
  {
    // Agentlet daemon and setup worker: build self-contained bundles from
    // source. We cannot just `cpSync` the `tsc`-emitted dist tree because its
    // `import { Command } from 'commander'` (and `ws`,
    // `@agentclientprotocol/sdk`, `@agentlet/protocol`) are bare
    // specifiers that need a `node_modules` to resolve — which we
    // don't ship in the packaged app. Bundling collapses everything
    // into one `index.js` next to `server.js`, matching what
    // `DaemonSupervisor.resolveDaemonEntry()` expects:
    //   1. HUABU_AGENTLET_DAEMON_PATH env override
    //   2. `<bundleDir>/agentlet/index.js` (packaged path — this build)
    //   3. `<repoRoot>/external/agentlet/packages/local/dist/index.js`
    //      (dev fallback when running `tsx src/server.ts` straight from
    //      the monorepo, which can still resolve bare specifiers
    //      against the workspace node_modules)
    entry: {
      index: path.resolve(
        '../../external/agentlet/packages/local/src/index.ts',
      ),
      'setup-worker': path.resolve(
        '../../external/agentlet/packages/agent-team/src/setup/managed-setup-worker.ts',
      ),
    },
    format: ['esm'],
    outDir: 'dist-bundle/agentlet',
    bundle: true,
    noExternal: [/.*/],
    splitting: false,
    sourcemap: false,
    clean: false,
    target: 'node22',
    banner: BANNER,
    esbuildOptions(options) {
      options.platform = 'node';
    },
  },
]);
