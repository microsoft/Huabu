// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the absolute path to the agentlet daemon entry script.
 *
 * This is L1 (host) deployment-layout knowledge: the generic
 * `@agenetes/agentlet-host` package must not embed Huabu's bundle
 * layout, so the host resolves the entry here and passes the absolute
 * path down via `mountAgenetes({ daemonEntryPath })`.
 *
 * Returns `null` when no candidate exists — the supervisor then
 * surfaces a permanent error and the bridge stays disabled.
 *
 * Resolution order:
 *   1. `HUABU_AGENTLET_DAEMON_PATH` env var — explicit override.
 *   2. `<bundleDir>/agentlet/index.js` — packaged Electron layout
 *      (tsup copies the daemon bundle next to `server.js`).
 *   3. `<repoRoot>/external/agentlet/packages/local/dist/index.js`
 *      — monorepo dev layout (relative to this source file).
 *
 * The first existing path wins.
 */
export function resolveDaemonEntry(): string | null {
  const env = process.env.HUABU_AGENTLET_DAEMON_PATH;
  if (env && existsSync(env)) return env;

  // import.meta.url resolves to this source file in dev (tsx) and to
  // the bundled server.js in production (every module collapses into
  // the same file under tsup --bundle). Two candidates handle both.
  const here = dirname(fileURLToPath(import.meta.url));

  // Production: dist-bundle/server.js → dist-bundle/agentlet/index.js
  const bundled = resolve(here, 'agentlet', 'index.js');
  if (existsSync(bundled)) return bundled;

  // Dev: apps/server/src/modules/agent/acp/daemon-entry.ts
  //   → external/agentlet/packages/local/dist/index.js
  const dev = resolve(
    here,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'external',
    'agentlet',
    'packages',
    'local',
    'dist',
    'index.js',
  );
  if (existsSync(dev)) return dev;

  return null;
}
