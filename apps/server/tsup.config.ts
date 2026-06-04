import { cpSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
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
  clean: true,
  // Target the Node version shipped with Electron 35 (~Node 22)
  target: 'node22',
  // Many bundled CJS packages call require('fs'), require('path'), etc.
  // In an ESM output file, `require` is not defined. This banner injects a
  // real `require` function so those CJS-style dynamic requires work correctly.
  // Using __createRequire alias to avoid conflicts with any bundled source that
  // also imports createRequire (e.g., pdf.loader.ts).
  banner: {
    js: `import { createRequire as __createRequire } from 'module';\nconst require = __createRequire(import.meta.url);`,
  },
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
  },
});
