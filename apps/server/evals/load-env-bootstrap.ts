// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Startup side-effects the eval CLI shares with `server.ts`.
 *
 * `cli.ts` imports this statically (`import './load-env-bootstrap.js'`)
 * so it runs before any module that touches `process.env`. The eval CLI
 * is a *second* entry point into server code, and whatever `server.ts`
 * does before serving its first request has to be repeated here — a
 * missing step surfaces as every case failing, which reads as a broken
 * agent rather than a broken runner.
 *
 * Order matters: env first, because `setup-proxy` decides whether to
 * install an undici dispatcher by reading `HTTPS_PROXY` at module load.
 * Reversed, a proxied network would silently go direct and every case
 * would die with `fetch failed`.
 */

import '../src/load-env.js';
import '../src/setup-proxy.js';
