// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import './load-env.js';
import './setup-proxy.js';
import { app } from './app.js';
import { resolveBindHost } from './bind-host.js';
import { prewarmOAuthCredentials } from './modules/agent/oauth.js';
import { resolveDeploymentConfig } from './modules/security/deployment-config.js';
import { initStorage } from './modules/storage/index.js';
import { initializeSecretStore } from './security/secret-store.js';
import { getLogger } from './utils/logger.js';

const log = getLogger('server');

const DEFAULT_PORT = 3001;
const parsedPort = Number.parseInt(
  process.env.SERVER_PORT ?? process.env.PORT ?? '',
  10,
);
const PORT =
  Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

const HOST = resolveBindHost();

async function start(): Promise<void> {
  try {
    const deployment = resolveDeploymentConfig();
    if (deployment.bindScope === 'network') {
      log.warn(
        'Remote access is enabled over operator-managed transport. Use HTTPS or a trusted private network.',
      );
    }

    // Before anything serves: an unknown or unimplemented backend must
    // fail here with an actionable message, not on the first upload.
    const storage = await initStorage();
    log.info(
      {
        structured: storage.profile.structured.kind,
        blobs: storage.profile.blobs.kind,
      },
      'Storage backends ready',
    );

    await initializeSecretStore();
    await app.listen({ port: PORT, host: HOST });
    // When bound to a wildcard address, "localhost" is still the URL a
    // browser on this machine would use — but log both so operators on a
    // remote machine know how to reach the server.
    const displayHost =
      HOST === '0.0.0.0' || HOST === '::'
        ? `localhost (bound on ${HOST})`
        : HOST;
    log.info(`Server running at http://${displayHost}:${PORT}`);

    // Warm up OAuth tokens off the request path so the first chat/Settings
    // action doesn't pay pi-ai's one-time lazy OAuth load + token refresh.
    prewarmOAuthCredentials();
  } catch (err) {
    log.error({ err }, 'Failed to start server');
    // Let Node drain Pino's asynchronous SonicBoom destinations before
    // exiting. A synchronous process.exit() here can run Pino's exit hook
    // before the destinations are ready and mask the real startup error.
    process.exitCode = 1;
  }
}

void start();

// Graceful shutdown on termination signals.
//
// This process is a child of the Electron main process (utilityProcess
// in the packaged app, `tsx watch` in dev). When the shell quits it
// sends us SIGTERM; a terminal Ctrl+C broadcasts SIGINT to the whole
// foreground group. Without an explicit handler Node takes the default
// action and terminates immediately — which SKIPS Fastify's `onClose`
// hooks. Those hooks are the ONLY thing that reaps the forked agentlet
// daemon (see daemon-supervisor.ts → `close()`) and releases the active
// external-note watch handles (see app.ts `onClose`), so a hard exit here
// orphans the daemon and leaves those handles wedged after the app
// is gone.
//
// On Windows there is no real POSIX signal delivery: Electron's
// `utilityProcess.kill()` (packaged) and the dev orchestrator's
// `taskkill /F` both call `TerminateProcess`, which bypasses these
// handlers entirely. So the Electron main process also asks us to shut
// down *cooperatively* via a `system:shutdown` message on the utility
// parent port (see apps/desktop/src/main.ts `before-quit`); that path is
// what actually runs `app.close()` on Windows before the hard-kill
// fallback fires.
//
// Calling `app.close()` runs the hooks (daemon killed, watcher closed,
// log stream flushed). A hard-timeout fallback guarantees we still exit
// even if a hook hangs (e.g. a wedged filesystem), so shutdown can never
// stall.
let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${reason}, shutting down…`);
  const forceExit = setTimeout(() => {
    log.warn('Graceful shutdown timed out after 3s; forcing exit');
    process.exit(1);
  }, 3000);
  forceExit.unref();
  app
    .close()
    .then(() => {
      clearTimeout(forceExit);
      process.exit(0);
    })
    .catch((err: unknown) => {
      log.error({ err }, 'Error during shutdown');
      clearTimeout(forceExit);
      process.exit(1);
    });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

// Cooperative shutdown request from the Electron main process. Required on
// Windows, where `utilityProcess.kill()` is a hard `TerminateProcess` that
// never triggers the signal handlers above. `parentPort` only exists when
// we were spawned as an Electron utility process; in dev (`tsx watch`) it
// is absent and this is a no-op.
interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}
const parentPort = (
  process as NodeJS.Process & { parentPort?: ParentPortLike | null }
).parentPort;
parentPort?.on('message', (event) => {
  const data = event?.data;
  if (
    data &&
    typeof data === 'object' &&
    (data as { type?: unknown }).type === 'system:shutdown'
  ) {
    shutdown('system:shutdown');
  }
});
