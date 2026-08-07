// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Regenerate desktop icon binaries from `build-resources/logo.svg`.
 *
 * Outputs (all overwritten in place):
 *   apps/desktop/build-resources/icon.png   512x512 PNG
 *       - BrowserWindow / dock icon at runtime (resolveIconPath in main.ts)
 *       - electron-builder picks this up as the Linux installer icon
 *   apps/desktop/build-resources/icon.icns  multi-res ICNS
 *       - macOS .app bundle icon (electron-builder)
 *   apps/desktop/build-resources/icon.ico   multi-res ICO
 *       - Windows installer icon + BrowserWindow icon on Win32
 *   apps/web/public/favicon.png             256x256 PNG
 *       - Browser favicon fallback when SVG isn't supported
 *
 * The SVG-encoded `favicon.svg` is the same artwork as `logo.svg` and is
 * already kept in sync by hand; this script does NOT touch it (writing it
 * would require an SVGO step we don't need).
 *
 * Run via:
 *   pnpm --filter @huabu/desktop run icons:build
 *
 * Pure JS — uses sharp (libvips, prebuilt) for SVG rasterisation and
 * png2icons for ICO/ICNS assembly. No native system tools required, so
 * the script runs identically on macOS / Linux / Windows / CI.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import png2icons from 'png2icons';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOURCES = join(HERE, '..', 'build-resources');
const WEB_PUBLIC = join(HERE, '..', '..', 'web', 'public');
const SOURCE_SVG = join(RESOURCES, 'logo.svg');

/**
 * Rasterise the source SVG to a square PNG of the given pixel size.
 *
 * `density` controls libvips' SVG rendering DPI — bumping it well above the
 * default (72) avoids the soft / blurry edges you get when downscaling from
 * an under-sampled raster. We tie it to the requested size so even 1024px
 * exports have a sharp source.
 *
 * `pad` is the transparent margin on EACH side, expressed as a fraction of
 * `size` (so `0.10` = 10% margin per side, artwork fills the central 80%).
 * Apple's macOS app-icon template expects ~10% margin around the artwork
 * so the Dock / Launchpad cell renders the icon at the same visual size as
 * native apps. Without this, our edge-to-edge
 * rounded square fills the entire cell and looks oversized.
 */
async function renderPng(size, pad = 0) {
  const svg = await readFile(SOURCE_SVG);
  const inner = Math.max(1, Math.round(size * (1 - pad * 2)));

  const innerPng = await sharp(svg, { density: Math.max(384, inner) })
    .resize(inner, inner, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer();

  if (pad === 0) return innerPng;

  // Composite the artwork onto a transparent square so the margin
  // becomes the visual padding macOS expects. `extract_area` /
  // `extend` would also work; `composite` keeps the alpha cleanest.
  const margin = Math.round((size - inner) / 2);
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: innerPng, left: margin, top: margin }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  // Apple's macOS app icon template expects ~10% transparent margin on
  // every side so the Dock / Launchpad / Mission Control cells render
  // us at the same visual size as native apps. Windows + Linux
  // installers tolerate the margin fine, so we apply it uniformly to
  // every desktop binary. The browser favicon stays edge-to-edge
  // because a browser tab's favicon slot is small enough that any
  // margin just shrinks the artwork.
  const ICON_PAD = 0.1;

  // 1024px master used as input for ICNS / ICO so the embedded
  // 512px and 256px representations are still down-sampled from a
  // hi-res source rather than the 512px file we ship as icon.png.
  const png1024 = await renderPng(1024, ICON_PAD);

  const png512 = await renderPng(512, ICON_PAD);
  await writeFile(join(RESOURCES, 'icon.png'), png512);
  console.log(`✓ build-resources/icon.png        (${png512.length} bytes)`);

  const png256 = await renderPng(256);
  await writeFile(join(WEB_PUBLIC, 'favicon.png'), png256);
  console.log(`✓ web/public/favicon.png          (${png256.length} bytes)`);

  // BILINEAR is the highest-quality resize option png2icons exposes;
  // the third arg (0) disables PNG re-compression (input is already
  // sharp's max compression). `false` for ICO = include all standard
  // Windows sizes (16/24/32/48/64/128/256), no Vista PNG-only mode.
  const icns = png2icons.createICNS(png1024, png2icons.BILINEAR, 0);
  if (!icns) throw new Error('png2icons.createICNS returned null');
  await writeFile(join(RESOURCES, 'icon.icns'), icns);
  console.log(`✓ build-resources/icon.icns       (${icns.length} bytes)`);

  const ico = png2icons.createICO(png1024, png2icons.BILINEAR, 0, false);
  if (!ico) throw new Error('png2icons.createICO returned null');
  await writeFile(join(RESOURCES, 'icon.ico'), ico);
  console.log(`✓ build-resources/icon.ico        (${ico.length} bytes)`);
}

main().catch((err) => {
  console.error('[build-icons] failed:', err);
  process.exit(1);
});
