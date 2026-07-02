import './load-env.js';
import './setup-proxy.js';
import { app } from './app.js';
import { resolveBindHost } from './bind-host.js';
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

app.listen({ port: PORT, host: HOST }, (err: Error | null) => {
  if (err) {
    log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
  // When bound to a wildcard address, "localhost" is still the URL a
  // browser on this machine would use — but log both so operators on a
  // remote machine know how to reach the server.
  const displayHost =
    HOST === '0.0.0.0' || HOST === '::' ? `localhost (bound on ${HOST})` : HOST;
  log.info(`Server running at http://${displayHost}:${PORT}`);
});

// Graceful shutdown on termination signals.
//
// This process is a child of the Electron main process (utilityProcess
// in the packaged app, `tsx watch` in dev). When the shell quits it
// sends us SIGTERM; a terminal Ctrl+C broadcasts SIGINT to the whole
// foreground group. Without an explicit handler Node takes the default
// action and terminates immediately — which SKIPS Fastify's `onClose`
// hooks. Those hooks are the ONLY thing that reaps the forked agentlet
// daemon (see daemon-supervisor.ts → `close()`), so a hard exit here
// orphans the daemon and it keeps running after the app is gone.
//
// Calling `app.close()` runs the hooks (daemon killed, log stream
// flushed). A hard-timeout fallback guarantees we still exit even if a
// hook hangs (e.g. a wedged filesystem), so shutdown can never stall.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down…`);
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
