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
