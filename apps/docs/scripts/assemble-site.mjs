// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(appRoot, '../..');
const landingPageDir = path.join(appRoot, 'landingpage');
const distDir = path.join(appRoot, 'dist');
const baseSegments = (process.env.DOCS_BASE_PATH ?? '/')
  .split('/')
  .filter(Boolean);
const basePath =
  baseSegments.length === 0 ? '/' : `/${baseSegments.join('/')}/`;
const canonicalOrigin = process.env.DOCS_CANONICAL_ORIGIN?.replace(/\/$/, '');

await cp(landingPageDir, distDir, { recursive: true });
await cp(
  path.join(repoRoot, 'assets', 'huabu-logo.svg'),
  path.join(distDir, 'huabu-logo.svg'),
);

const landingPagePath = path.join(distDir, 'index.html');
const source = await readFile(landingPagePath, 'utf8');
const canonicalUrl = canonicalOrigin
  ? `${canonicalOrigin}${basePath}`
  : basePath;
const socialPreviewUrl = canonicalOrigin
  ? `${canonicalOrigin}${basePath}huabu-social-preview-v10.png`
  : `${basePath}huabu-social-preview-v10.png`;

for (const placeholder of [
  '__HUABU_CANONICAL_URL__',
  '__HUABU_SOCIAL_PREVIEW_URL__',
]) {
  if (!source.includes(placeholder))
    throw new Error(`Missing landing page placeholder: ${placeholder}`);
}

const html = source
  .replaceAll('__HUABU_CANONICAL_URL__', canonicalUrl)
  .replaceAll('__HUABU_SOCIAL_PREVIEW_URL__', socialPreviewUrl)
  .replaceAll('../../../assets/huabu-logo.svg', `${basePath}huabu-logo.svg`);

await writeFile(landingPagePath, html);
