import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Minimal HTTP Basic Auth gate for the dev server.
 * Protects every request reaching Vite (including /api proxied to Fastify),
 * but does NOT cover the HMR WebSocket upgrade (which only carries hot
 * reload payloads, no app data) — so HMR keeps working without creds.
 *
 * Note: this is plaintext over HTTP. Combine with a firewall / VPN for
 * anything beyond a quick team share on a trusted network.
 */
function basicAuthPlugin(user: string, pass: string): Plugin {
  const expected =
    'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  return {
    name: 'sediment-basic-auth',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // CORS preflight never carries credentials — let it through.
        if (req.method === 'OPTIONS') return next();
        if (req.headers.authorization === expected) return next();
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Basic realm="Sediment"');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Authentication required');
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Resolve env with the same precedence as the server:
  //   shell `process.env`  >  apps/web/.env  >  <repo-root>/.env
  // `loadEnv` only reads .env files, so we explicitly merge `process.env` on
  // top — otherwise running `SERVER_PORT=4000 pnpm dev` would leave the Vite
  // proxy pointing at the default 3001 while the backend listens on 4000.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '../..');
  const env: Record<string, string | undefined> = {
    ...loadEnv(mode, repoRoot, ''),
    ...loadEnv(mode, here, ''),
    ...process.env,
  };

  const apiPort = env.SERVER_PORT || env.PORT || '3001';
  const apiTarget = env.VITE_API_PROXY_TARGET || `http://localhost:${apiPort}`;
  const parsedDevPort = Number.parseInt(
    env.WEB_PORT || env.VITE_PORT || '',
    10,
  );
  const devPort =
    Number.isFinite(parsedDevPort) && parsedDevPort > 0 ? parsedDevPort : 5173;

  const authUser = env.HUABU_BASIC_AUTH_USER;
  const authPass = env.HUABU_BASIC_AUTH_PASS;
  const authEnabled = Boolean(authUser && authPass);
  if (authEnabled) {
    console.log('[sediment] Vite dev server: Basic Auth enabled');
  }

  return {
    plugins: [
      react(),
      ...(authEnabled
        ? [basicAuthPlugin(authUser as string, authPass as string)]
        : []),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    optimizeDeps: {
      include: ['gpt-tokenizer/encoding/o200k_base'],
    },
    server: {
      host: true,
      port: devPort,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
