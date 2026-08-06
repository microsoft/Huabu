#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Generate `dist/splash.html` — the page shown by the startup splash window.
 *
 * Why generate instead of committing a static file: the animation is the same
 * brand asset the web app uses (`apps/web/src/assets/loading.json`) and the
 * player is a dependency, so checking copies into `apps/desktop` would create
 * two things to keep in sync. Inlining both at build time also makes the page
 * self-contained, which matters because the splash has to render before the
 * Fastify server exists — there is nothing to fetch relative paths from, and
 * the dev and packaged layouts differ.
 *
 * The output lands in `dist/`, which `electron-builder`'s `files: dist/**`
 * already ships, so packaging needs no extra entry.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');

/**
 * The "light" player: SVG renderer only, no expression engine. The brand
 * animation is plain shape layers, and this build is roughly a third of the
 * full player.
 */
const player = readFileSync(
  require.resolve('lottie-web/build/player/lottie_light.min.js'),
  'utf8',
);
const animation = readFileSync(
  path.resolve(desktopRoot, '../web/src/assets/loading.json'),
  'utf8',
);

// Both are embedded in classic `<script>` bodies, where the HTML parser ends
// the element at the first `</script>` regardless of JavaScript syntax.
for (const [name, source] of [
  ['lottie player', player],
  ['loading.json', animation],
]) {
  if (/<\/script/i.test(source)) {
    throw new Error(`Refusing to inline ${name}: it contains "</script"`);
  }
}

// `--bg-default` from apps/web/src/index.css. Hard-coded because the splash
// renders before any app stylesheet exists.
const BACKGROUND = '#f5f5f5';
const INDICATOR_PX = 44;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Huabu</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
        overflow: hidden;
        background: ${BACKGROUND};
        /* The window is frameless, so the whole surface is the drag handle. */
        -webkit-app-region: drag;
        -webkit-user-select: none;
        cursor: default;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #indicator {
        width: ${INDICATOR_PX}px;
        height: ${INDICATOR_PX}px;
      }
    </style>
  </head>
  <body>
    <div id="indicator"></div>
    <script>${player}</script>
    <script>
      lottie.loadAnimation({
        container: document.getElementById('indicator'),
        renderer: 'svg',
        loop: true,
        autoplay: true,
        animationData: ${animation},
      });
    </script>
  </body>
</html>
`;

const outDir = path.join(desktopRoot, 'dist');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'splash.html');
writeFileSync(outFile, html, 'utf8');
console.log(
  `[desktop] wrote ${path.relative(desktopRoot, outFile)} (${Math.round(
    html.length / 1024,
  )} KB)`,
);
