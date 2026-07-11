import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { normalizeBasePath } from './src/normalizeBasePath';

export default defineConfig(({ isSsrBuild }) => ({
  base: normalizeBasePath(process.env.DOCS_BASE_PATH),
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5174,
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
}));
