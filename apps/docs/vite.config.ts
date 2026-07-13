import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { normalizeBasePath } from './src/normalizeBasePath';

export default defineConfig(({ isSsrBuild }) => {
  const parsedDocsPort = Number.parseInt(process.env.DOCS_PORT || '', 10);
  const docsPort =
    Number.isFinite(parsedDocsPort) && parsedDocsPort > 0
      ? parsedDocsPort
      : 5174;

  return {
    base: normalizeBasePath(process.env.DOCS_BASE_PATH),
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host: true,
      port: docsPort,
      strictPort: true,
    },
    preview: {
      host: true,
      port: 4174,
      strictPort: true,
    },
    build: {
      manifest: !isSsrBuild,
      sourcemap: false,
    },
  };
});
