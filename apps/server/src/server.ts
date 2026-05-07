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
app.listen({ port: PORT, host: '0.0.0.0' }, (err: Error | null) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server running at http://localhost:${PORT}`);
});
