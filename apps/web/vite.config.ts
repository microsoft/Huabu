import { readFileSync } from 'node:fs';
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

  // The desktop app's `package.json` is the single source of truth for
  // the user-facing product version (web's own version is `0.0.0`).
  // Inline it at build time so the Settings panel can render `v<x.y.z>`
  // without a runtime fetch.
  const desktopPkg = JSON.parse(
    readFileSync(path.resolve(here, '../desktop/package.json'), 'utf8'),
  ) as { version?: string };
  const appVersion = desktopPkg.version ?? '0.0.0';

  return {
    plugins: [
      react(),
      ...(authEnabled
        ? [basicAuthPlugin(authUser as string, authPass as string)]
        : []),
    ],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      // Pre-transform the heavy CanvasPage import graph in the background
      // right after `pnpm dev` finishes starting, so by the time you open the
      // browser the modules are already cached and there is no on-demand
      // compile penalty on first navigation.
      //
      // Only list the *entry* files of the slowest route; Vite recursively
      // crawls their imports. Keep this list small — listing too many files
      // burns extra CPU at server start without proportional benefit.
      warmup: {
        clientFiles: [
          './src/App.tsx',
          './src/pages/CanvasPage/CanvasPage.tsx',
          './src/pages/CanvasPage/MainLayout.tsx',
          './src/pages/CanvasPage/CenterArea.tsx',
          './src/components/Panels/Canvas/Canvas.tsx',
          './src/store/canvasStore.ts',
        ],
      },
      host: true,
      port: devPort,
      // `strictPort: true` makes Vite ABORT instead of silently sliding
      // to the next free port when its requested one is taken. Silent
      // sliding is dangerous in orchestrated dev (scripts/dev-desktop.mjs):
      // the orchestrator commits a specific port to Electron's
      // WEB_DEV_SERVER_URL *before* Vite finishes binding, and if Vite
      // slides we lose URL-port sync and Electron loads a phantom
      // backend on the original port (e.g. a stale Vite from a previous
      // session). Aborting surfaces the conflict immediately. For plain
      // `pnpm dev:web` this just turns the rare \"hidden\" port-slide
      // into a loud error, which is the better default UX anyway.
      strictPort: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    // `vite preview` serves the production build but does NOT inherit
    // `server.proxy`, so mirror the `/api` proxy here to let preview builds
    // talk to the same backend (useful for profiling real production output
    // without the dev module-compilation overhead).
    preview: {
      port: devPort,
      strictPort: true,
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
