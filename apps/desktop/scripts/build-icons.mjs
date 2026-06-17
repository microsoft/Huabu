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
 *   pnpm --filter @sediment/desktop run icons:build
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
 */
async function renderPng(size) {
  const svg = await readFile(SOURCE_SVG);
  return sharp(svg, { density: Math.max(384, size) })
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  // 1024px master used as input for ICNS / ICO so the embedded
  // 512px and 256px representations are still down-sampled from a
  // hi-res source rather than the 512px file we ship as icon.png.
  const png1024 = await renderPng(1024);

  const png512 = await renderPng(512);
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
