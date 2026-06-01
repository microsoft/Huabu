import './load-env.js';
import './setup-proxy.js';
import { app } from './app.js';

const DEFAULT_PORT = 3001;
const parsedPort = Number.parseInt(
  process.env.SERVER_PORT ?? process.env.PORT ?? '',
  10,
);
const PORT =
  Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

// Default to loopback so a fresh install is not silently exposed to the
// local network. Operators who explicitly want LAN / remote access set
// `HUABU_BIND_HOST=0.0.0.0` (or a specific interface IP). Pair that
// with `HUABU_ALLOWED_HOSTS` and `HUABU_BASIC_AUTH_*` — see README.
const HOST = process.env.HUABU_BIND_HOST ?? '127.0.0.1';

app.listen({ port: PORT, host: HOST }, (err: Error | null) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  // When bound to a wildcard address, "localhost" is still the URL a
  // browser on this machine would use — but log both so operators on a
  // remote machine know how to reach the server.
  const displayHost =
    HOST === '0.0.0.0' || HOST === '::' ? `localhost (bound on ${HOST})` : HOST;
  console.log(`Server running at http://${displayHost}:${PORT}`);
});
