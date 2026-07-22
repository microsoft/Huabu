#!/usr/bin/env node
/**
 * Start the production-style standalone web app.
 *
 * The root `start:web` script builds the server and web client first. This
 * launcher then points the bundled Fastify server at the compiled SPA so the
 * UI and API share one port, without Vite or file watchers.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// The bundled server's source-relative root `.env` lookup no longer points at
// the repository, so load it here before importing the bundle. Existing shell
// variables retain higher precedence because dotenv does not override them.
dotenv.config({ path: path.join(repoRoot, '.env') });

process.env.WEB_DIST_PATH = path.resolve(
  repoRoot,
  process.env.WEB_DIST_PATH ?? 'apps/web/dist',
);

// Match `pnpm dev:server`, whose working directory is apps/server, so switching
// launch modes keeps using the same credential store, logs, and saved settings.
process.env.HUABU_DATA_DIR = path.resolve(
  repoRoot,
  process.env.HUABU_DATA_DIR ?? 'apps/server/data',
);

await import('../apps/server/dist-bundle/server.js');
