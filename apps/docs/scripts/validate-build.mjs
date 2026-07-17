// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const distDir = path.join(appRoot, 'dist');
const source = await readFile(
  path.join(appRoot, 'src', 'navigation.ts'),
  'utf8',
);
const routes = [...source.matchAll(/to: '(\/docs[^']*)'/g)].map(
  (match) => match[1],
);
const uniqueRoutes = [...new Set(routes)];
const failures = [];
const baseSegments = (process.env.DOCS_BASE_PATH ?? '/')
  .split('/')
  .filter(Boolean);
const basePath =
  baseSegments.length === 0 ? '/' : `/${baseSegments.join('/')}/`;
const canonicalOrigin = process.env.DOCS_CANONICAL_ORIGIN?.replace(/\/$/, '');

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function validateLocalReference(reference, sourceFile) {
  if (reference.startsWith('#')) return;

  const url = new URL(reference, 'https://handbook.invalid');
  if (url.origin !== 'https://handbook.invalid') return;

  let pathname = decodeURIComponent(url.pathname);
  if (basePath !== '/') {
    if (!pathname.startsWith(basePath)) {
      failures.push(
        `Reference escapes DOCS_BASE_PATH in ${sourceFile}: ${reference}`,
      );
      return;
    }
    pathname = `/${pathname.slice(basePath.length)}`;
  }

  const relativePath = pathname.replace(/^\//, '');
  const target = pathname.endsWith('/')
    ? path.join(distDir, relativePath, 'index.html')
    : path.join(distDir, relativePath);
  if (!(await exists(target))) {
    failures.push(`Missing local reference in ${sourceFile}: ${reference}`);
  }
}

for (const route of uniqueRoutes) {
  const htmlPath = path.join(
    distDir,
    ...route.split('/').filter(Boolean),
    'index.html',
  );
  if (!(await exists(htmlPath))) {
    failures.push(`Missing prerendered route: ${route}`);
    continue;
  }
  const html = await readFile(htmlPath, 'utf8');
  if (!html.includes('<article') || !html.includes('data-pagefind-body'))
    failures.push(`Missing indexed article: ${route}`);
  if (!/<h1[ >]/.test(html)) failures.push(`Missing H1: ${route}`);
  if (html.includes('data-docs-loading'))
    failures.push(`Suspense fallback was prerendered: ${route}`);
  if (!/<title>[^<]+ · Huabu Handbook<\/title>/.test(html))
    failures.push(`Missing route title: ${route}`);
  if (!html.includes('<script type="module"'))
    failures.push(`Missing hydration entry: ${route}`);
  if (/localhost|[A-Z]:\\|VITE_/.test(html))
    failures.push(`Forbidden build value in: ${route}`);

  const references = [
    ...html.matchAll(/<(?:a|link)\b[^>]*\bhref="([^"]+)"/g),
    ...html.matchAll(/<(?:img|script)\b[^>]*\bsrc="([^"]+)"/g),
  ].map((match) => match[1]);
  for (const reference of references) {
    await validateLocalReference(reference, route);
  }
}

const root = await readFile(path.join(distDir, 'index.html'), 'utf8');
if (
  !root.includes(
    '<title>Huabu, where you and your agents think together</title>',
  )
)
  failures.push('Missing landing page at artifact root');
if (!root.includes('href="./docs/"'))
  failures.push('Missing landing page link to the handbook');
const expectedCanonicalUrl = canonicalOrigin
  ? `${canonicalOrigin}${basePath}`
  : basePath;
const expectedSocialPreviewUrl = canonicalOrigin
  ? `${canonicalOrigin}${basePath}huabu-social-preview-v10.png`
  : `${basePath}huabu-social-preview-v10.png`;
if (!root.includes(`<link rel="canonical" href="${expectedCanonicalUrl}" />`))
  failures.push('Invalid landing page canonical URL');
if (
  !root.includes(`<meta property="og:url" content="${expectedCanonicalUrl}" />`)
)
  failures.push('Invalid landing page Open Graph URL');
for (const attribute of [
  `property="og:image" content="${expectedSocialPreviewUrl}"`,
  `name="twitter:image" content="${expectedSocialPreviewUrl}"`,
]) {
  if (!root.includes(attribute))
    failures.push(`Invalid landing page social preview URL: ${attribute}`);
}
if (/__HUABU_[A-Z_]+__/.test(root))
  failures.push('Unresolved landing page build placeholder');
if (!root.includes(`url('${basePath}huabu-logo.svg')`))
  failures.push('Missing or invalid logo image URL in landing page');
for (const asset of [
  'huabu-logo.svg',
  'huabu-social-preview-v10.png',
  'image-for-shell-act.png',
]) {
  if (!(await exists(path.join(distDir, asset))))
    failures.push(`Missing landing page asset: ${asset}`);
}
const pagefindDir = path.join(distDir, 'pagefind');
if (!(await exists(path.join(pagefindDir, 'pagefind-ui.js'))))
  failures.push('Missing Pagefind UI runtime');
if (!(await exists(path.join(pagefindDir, 'pagefind.js'))))
  failures.push('Missing Pagefind search runtime');
if ((await readdir(pagefindDir).catch(() => [])).length < 3)
  failures.push('Pagefind index is incomplete');

const htmlFiles = [];
async function collectHtml(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectHtml(target);
    else if (entry.name === 'index.html') htmlFiles.push(target);
  }
}
await collectHtml(path.join(distDir, 'docs'));
if (htmlFiles.length !== uniqueRoutes.length)
  failures.push(
    `Expected ${uniqueRoutes.length} route pages, found ${htmlFiles.length}`,
  );

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `Validated the landing page, ${uniqueRoutes.length} prerendered handbook routes, and Pagefind output.`,
);
