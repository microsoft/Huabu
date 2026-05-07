import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

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

  return {
    plugins: [react()],
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
