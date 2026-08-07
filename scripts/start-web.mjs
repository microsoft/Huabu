#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

import { findAvailablePort } from './dev-ports.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const DEFAULT_SERVER_PORT = 3001;

// The bundled server's source-relative root `.env` lookup no longer points at
// the repository, so load it here before importing the bundle. Existing shell
// variables retain higher precedence because dotenv does not override them.
dotenv.config({ path: path.join(repoRoot, '.env') });

const configuredPort = Number.parseInt(
  process.env.SERVER_PORT ?? process.env.PORT ?? '',
  10,
);
const preferredPort =
  Number.isInteger(configuredPort) &&
  configuredPort > 0 &&
  configuredPort <= 65_535
    ? configuredPort
    : DEFAULT_SERVER_PORT;
const serverPort = await findAvailablePort(preferredPort);
if (serverPort !== preferredPort) {
  console.warn(
    `[start:web] Port ${preferredPort} is in use; using ${serverPort} instead.`,
  );
}
process.env.SERVER_PORT = String(serverPort);

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
