/**
 * `rasterize_node` handler — produce a PNG artifact from a canvas node.
 *
 * Returns `{src, width, height}` as a JSON string. The agent typically
 * chains this into `generate_image({referenceArtifactSrcs: [src]})`
 * to use the result as a visual reference for AI image generation.
 *
 * Supported node types in v1:
 *   - `image` / `video` — pass-through: returns the existing
 *     `data.src` artifact key (no re-encoding, no extra disk write).
 *   - `pdf`             — returns `data.coverUrl` when present;
 *                         throws "no cover" otherwise.
 *   - `sketch`          — renders strokes (via perfect-freehand) into
 *                         a full SVG document and rasterizes to PNG
 *                         with @resvg/resvg-wasm.
 *
 * Out of v1 scope (returns a clear error directing the agent to a
 * better path):
 *   - `note` / `text`   — agent should `read("nodes/<file>.md")` and
 *                         weave the text into its prompt instead.
 *   - `frame`           — composite rasterization deferred; agent
 *                         should rasterize individual children.
 *   - `audio` / `web` / `office` / `question` — no meaningful raster
 *                         representation.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { getStroke } from 'perfect-freehand';

import { createId } from '@sediment/shared';

import { getCanvasStore } from '../../../storage/index.js';

import type { rasterizeNodeParamsSchema } from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

export type RasterizeNodeArgs = Static<typeof rasterizeNodeParamsSchema> & {
  canvasId: string;
};

// ─── perfect-freehand options ──────────────────────────────────────────────
// Mirror the web client's defaults (see
// apps/web/src/components/Nodes/sketch/sketchPath.ts SKETCH_OPTIONS) so
// the AI's view of the sketch matches what the user sees on canvas.
const SKETCH_OPTIONS = {
  size: 4,
  thinning: 0.5,
  smoothing: 0.5,
  streamline: 0.5,
  easing: (t: number) => t,
  start: { taper: 1, easing: (t: number) => t, cap: true },
  end: { taper: 1, easing: (t: number) => t, cap: true },
};
const DEFAULT_STROKE_SIZE = SKETCH_OPTIONS.size;
const DEFAULT_STROKE_COLOR = '#000000';

// ─── Raw node shape (parsed loosely from canvas.json) ──────────────────────
interface RawNode {
  id: string;
  data?: {
    type?: string;
    src?: string;
    coverUrl?: string;
    strokes?: Array<{
      points: number[][];
      color?: string;
      size?: number;
    }>;
    initialSize?: { width: number; height: number };
    [key: string]: unknown;
  };
}

// ─── Resvg WASM init ───────────────────────────────────────────────────────
// initWasm() must run exactly once before any Resvg constructor call.
// We lazy-init on first use and memoise the promise so concurrent
// rasterize calls (e.g. agent rasterising 3 sketches in parallel) all
// await the same init.
let wasmInitPromise: Promise<void> | null = null;
async function ensureResvgReady(): Promise<void> {
  if (wasmInitPromise) return wasmInitPromise;
  wasmInitPromise = (async () => {
    // Try dev path first (resolves through node_modules), fall back to
    // bundle path (sibling of the bundled server.js). The bundle copy
    // is performed by tsup.config.ts's onSuccess hook, mirroring the
    // sql-wasm.wasm pattern.
    let wasmBytes: Buffer | null = null;
    try {
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm');
      wasmBytes = await readFile(wasmPath);
    } catch {
      // Bundle path
      const wasmPath = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        'resvg-bg.wasm',
      );
      wasmBytes = await readFile(wasmPath);
    }
    await initWasm(wasmBytes);
  })();
  return wasmInitPromise;
}

// ─── SVG path generation (mirrors web sketchPath.ts) ───────────────────────
function strokeToSvgPathD(stroke: number[][]): string {
  if (!stroke.length) return '';
  const d = stroke.reduce(
    (acc: (string | number)[], [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, ',', (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ['M', ...stroke[0], 'Q'],
  );
  d.push('Z');
  return d.join(' ');
}

function pointsToPathD(points: number[][], size: number): string {
  const stroke = getStroke(points, { ...SKETCH_OPTIONS, size });
  return strokeToSvgPathD(stroke);
}

/**
 * Build a complete SVG document from a sketch node's strokes.
 *
 * `initialSize` is the node-local coordinate system the strokes were
 * captured in. Resvg renders to that same coordinate system so the
 * PNG matches what the user drew at 1× zoom.
 */
function sketchToSvg(node: RawNode): {
  svg: string;
  width: number;
  height: number;
} {
  const strokes = node.data?.strokes ?? [];
  const init = node.data?.initialSize;
  const width = Math.max(1, Math.round(init?.width ?? 256));
  const height = Math.max(1, Math.round(init?.height ?? 256));
  const paths = strokes
    .map((s) => {
      const color = s.color || DEFAULT_STROKE_COLOR;
      const size = s.size ?? DEFAULT_STROKE_SIZE;
      const d = pointsToPathD(s.points ?? [], size);
      if (!d) return '';
      return `<path d="${d}" fill="${escapeXml(color)}" />`;
    })
    .filter(Boolean)
    .join('');
  // White background so the rasterized sketch looks like paper rather
  // than a transparent void when the AI receives it.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#ffffff" />` +
    paths +
    `</svg>`;
  return { svg, width, height };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<'
      ? '&lt;'
      : c === '>'
        ? '&gt;'
        : c === '&'
          ? '&amp;'
          : c === '"'
            ? '&quot;'
            : '&apos;',
  );
}

// ─── Handler ───────────────────────────────────────────────────────────────
export async function handleRasterizeNode(
  args: RasterizeNodeArgs,
): Promise<string> {
  const store = getCanvasStore(args.canvasId);
  const canvas = store.read();
  if (!canvas) {
    throw new Error(`Canvas ${args.canvasId} not found`);
  }
  const nodes = (canvas.state.nodes ?? []) as RawNode[];
  const node = nodes.find((n) => n?.id === args.nodeId);
  if (!node) {
    throw new Error(`Node ${args.nodeId} not found on canvas ${args.canvasId}`);
  }

  const type = node.data?.type;

  // ── Pass-through cases ────────────────────────────────────────────────
  if (type === 'image' || type === 'video') {
    const src = node.data?.src;
    if (!src) {
      throw new Error(
        `Node ${args.nodeId} (${type}) has no src — nothing to rasterize. The artifact may have been deleted.`,
      );
    }
    // We don't know the original dimensions without decoding the PNG;
    // 0/0 signals "unknown" to the agent, which can pass the src
    // straight to `generate_image` regardless.
    return JSON.stringify({ src, width: 0, height: 0 });
  }

  if (type === 'pdf') {
    const cover = node.data?.coverUrl;
    if (!cover) {
      throw new Error(
        `PDF node ${args.nodeId} has no cover image. Open the node and capture a cover first, or rasterize a different node.`,
      );
    }
    return JSON.stringify({ src: cover, width: 0, height: 0 });
  }

  // ── Sketch: render SVG → PNG via resvg-wasm ───────────────────────────
  if (type === 'sketch') {
    const { svg, width, height } = sketchToSvg(node);
    if (!node.data?.strokes?.length) {
      throw new Error(
        `Sketch node ${args.nodeId} has no strokes — nothing to rasterize.`,
      );
    }
    await ensureResvgReady();
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: width },
      background: '#ffffff',
    });
    const png = Buffer.from(resvg.render().asPng());
    const id = createId('artifact');
    const record = await store.writeArtifactBuffer(
      { id, ext: '.png', mimeType: 'image/png' },
      png,
    );
    return JSON.stringify({ src: record.filename, width, height });
  }

  // ── Helpful error for unsupported types ───────────────────────────────
  if (type === 'note' || type === 'text') {
    throw new Error(
      `Node ${args.nodeId} is a ${type} node. Rasterizing text is wasteful — use \`read("nodes/<file>.md")\` to fetch its content and weave that into your image prompt instead.`,
    );
  }
  if (type === 'frame') {
    throw new Error(
      `Frame rasterization is not yet supported. Rasterize individual children (image / sketch / pdf cover) instead.`,
    );
  }
  throw new Error(
    `Node type "${type ?? 'unknown'}" cannot be rasterized. Supported: image, video, pdf, sketch.`,
  );
}
