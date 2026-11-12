#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Start the production-style standalone web app.
 *
 * `start:web` builds first; `start:web:built` runs existing build artifacts.
 * Both point the bundled Fastify server at the compiled SPA so the UI and API
 * share one port, without Vite or file watchers.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { resolveServerDataDir } from '../packages/client-runtime/dist/bootstrap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

process.env.HUABU_REPO_ROOT = repoRoot;

// The bundled server's source-relative root `.env` lookup no longer points at
// the repository, so load it here before importing the bundle. Existing shell
// variables retain higher precedence because dotenv does not override them.
dotenv.config({ path: path.join(repoRoot, '.env') });

// Images may carry a build-time revision without Git or repository metadata.
// A source checkout still discovers its revision for the personal Canary.
if (!process.env.HUABU_DEPLOYED_SHA?.trim()) {
  try {
    process.env.HUABU_DEPLOYED_SHA = execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    delete process.env.HUABU_DEPLOYED_SHA;
  }
}

process.env.WEB_DIST_PATH = path.resolve(
  repoRoot,
  process.env.WEB_DIST_PATH ?? 'apps/web/dist',
);

// Match `pnpm dev:server`, whose working directory is apps/server, so switching
// launch modes keeps using the same credential store, logs, and saved settings.
process.env.HUABU_DATA_DIR = resolveServerDataDir(
  repoRoot,
  process.env.HUABU_DATA_DIR,
);

await import('../apps/server/dist-bundle/server.js');
