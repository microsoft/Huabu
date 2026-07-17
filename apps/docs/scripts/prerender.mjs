// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const distDir = path.join(appRoot, 'dist');
const ssrDir = path.join(appRoot, '.ssr');
const serverEntry = path.join(ssrDir, 'entry-server.js');
const template = await readFile(path.join(distDir, 'index.html'), 'utf8');
const { docsBasePath, renderRoute, routeManifest } = await import(
  `${pathToFileURL(serverEntry).href}?build=${Date.now()}`
);
const canonicalOrigin = process.env.DOCS_CANONICAL_ORIGIN?.replace(/\/$/, '');

function escapeAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

for (const route of routeManifest) {
  const markup = await renderRoute(route.path);
  const canonical = canonicalOrigin
    ? `<link rel="canonical" href="${escapeAttribute(`${canonicalOrigin}${docsBasePath.replace(/\/$/, '')}${route.path}/`)}" />`
    : '';
  const html = template
    .replace(
      /<title>.*?<\/title>/s,
      `<title>${escapeAttribute(route.title)} · Huabu Handbook</title>`,
    )
    .replace(
      /<meta name="description" content=".*?" \/>/s,
      `<meta name="description" content="${escapeAttribute(route.description)}" />`,
    )
    .replace('</head>', `  ${canonical}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root">${markup}</div>`);
  const routeDir = path.join(distDir, ...route.path.split('/').filter(Boolean));
  await mkdir(routeDir, { recursive: true });
  await writeFile(path.join(routeDir, 'index.html'), html);
}

await rm(ssrDir, { recursive: true, force: true });
