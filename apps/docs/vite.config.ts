// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { normalizeBasePath } from './src/normalizeBasePath';

const previewDirectoryIndexes = {
  name: 'preview-directory-indexes',
  configurePreviewServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (request.url) {
        const url = new URL(request.url, 'http://preview.local');
        if (url.pathname.endsWith('/')) {
          url.pathname += 'index.html';
          request.url = `${url.pathname}${url.search}`;
        }
      }
      next();
    });
  },
} satisfies Plugin;

export default defineConfig(({ isPreview, isSsrBuild }) => {
  const parsedDocsPort = Number.parseInt(process.env.DOCS_PORT || '', 10);
  const docsPort =
    Number.isFinite(parsedDocsPort) && parsedDocsPort > 0
      ? parsedDocsPort
      : 43127;

  return {
    appType: isPreview ? 'mpa' : 'spa',
    base: normalizeBasePath(process.env.DOCS_BASE_PATH),
    plugins: [previewDirectoryIndexes, react()],
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
      port: 43128,
      strictPort: true,
    },
    build: {
      manifest: !isSsrBuild,
      sourcemap: false,
    },
  };
});
