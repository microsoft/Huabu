// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Resolve the network interface to bind on, defaulting to loopback so a
 * fresh install is never silently exposed to the local network.
 *
 * Operators who explicitly want LAN / remote access set
 * `HUABU_BIND_HOST=0.0.0.0` (or a specific interface IP) and pair that
 * with `HUABU_ALLOWED_HOSTS` and `HUABU_BASIC_AUTH_*` — see README.
 *
 * Lives in its own module (not inlined into `server.ts`) so the default
 * can be regression-tested without booting Fastify. The Electron
 * desktop shell relies on this defaulting to loopback; if anyone later
 * switches the default to `0.0.0.0` the test in `bind-host.test.ts`
 * will fail loudly.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.HUABU_BIND_HOST ?? '127.0.0.1';
}
