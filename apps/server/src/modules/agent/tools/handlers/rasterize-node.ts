/**
 * `rasterize_nodes` handler — produce PNG artifacts from canvas nodes.
 *
 * Accepts a list of node ids and returns one artifact entry per group:
 *   - Each `image` / `video` node is a pass-through (its existing
 *     `data.src` artifact key is returned, no extra disk write).
 *   - Each `pdf` node returns its `data.coverUrl` (or throws if none).
 *   - `sketch` nodes are bucketed by `parentId` and then spatially
 *     clustered (single-linkage, 200 px threshold — same rule the web
 *     selection pipeline used to apply). Each cluster is rendered in
 *     **world coordinates** so multiple strokes share one SVG
 *     `viewBox` and the resulting PNG faithfully reproduces their
 *     spatial relationship on the canvas. The cluster is then
 *     rasterized via `@resvg/resvg-wasm`.
 *
 * Sketch rasters are **content-addressed**: the artifact filename
 * embeds a SHA-256 fingerprint of the cluster's strokes + geometry.
 * Re-rasterising an unchanged sketch returns the same `src` without
 * writing a new file, which prevents `.artifacts/` from exploding when
 * the agent route auto-rasterises selections on every send.
 *
 * Out of scope (each yields a clear error directing the caller to a
 * better path):
 *   - `note` / `text`   — read `nodes/<file>.md` instead.
 *   - `frame`           — rasterize individual children.
 *   - `audio` / `web` / `office` / `question` — no meaningful raster.
 *
 * Returns a JSON-stringified `Array<{src, width, height, originNodeIds}>`.
 * `originNodeIds` lists every node that contributed to that artifact —
 * a sketch cluster of N strokes lists all N ids; a pass-through image
 * lists its single id.
 *
 * For internal callers (e.g. `agent.route.ts` auto-rasterising the
 * user's sketch selection at chat send time) we also export
 * {@link rasterizeNodesToArtifacts}, which returns the typed array
 * directly so callers don't have to JSON-parse it back.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { getStroke } from 'perfect-freehand';

import { findClusters, resolveAccent } from '@sediment/shared';

import { getCanvasStore } from '../../../storage/index.js';

import type { rasterizeNodesParamsSchema } from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';
import type { SpatialNode } from '@sediment/shared';

export type RasterizeNodesArgs = Static<typeof rasterizeNodesParamsSchema> & {
  canvasId: string;
};

/** Typed shape of one entry in the JSON result array. */
export interface RasterizeNodeResult {
  /** Artifact key — bare filename like `<id>.png`, ready for `data.src`. */
  src: string;
  /** Width in PNG pixels (0 = unknown, e.g. for pass-through). */
  width: number;
  /** Height in PNG pixels (0 = unknown, e.g. for pass-through). */
  height: number;
  /** Canvas node ids that contributed to this artifact. */
  originNodeIds: string[];
}

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
const DEFAULT_STROKE_COLOR = 'black';

// ─── Cluster rendering knobs ───────────────────────────────────────────────
// Padding around the cluster bbox (flow-space units). Mirrors
// apps/web/src/handler/sketch/sketchToImage.ts DEFAULT_PADDING.
const CLUSTER_PADDING = 16;
// Max PNG dimension. Clusters larger than this are scaled to fit.
const CLUSTER_MAX_PIXELS = 2048;
// Edge-to-edge clustering threshold (flow-space px). Mirrors
// apps/web/src/handler/sketch/sketchClustering.ts CLUSTER_DISTANCE_THRESHOLD.
const CLUSTER_DISTANCE_THRESHOLD = 200;

// ─── Raw node shape (parsed loosely from canvas.json) ──────────────────────
interface RawNode {
  id: string;
  parentId?: string;
  position?: { x: number; y: number };
  width?: number;
  height?: number;
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

// ─── Sketch helpers ────────────────────────────────────────────────────────
/**
 * Effective on-canvas size for a sketch node. Prefers React Flow's
 * measured `width` / `height` (which reflect any user resize), then
 * `data.initialSize`, then 0.
 */
function sketchEffectiveSize(n: RawNode): { width: number; height: number } {
  const w = n.width ?? n.data?.initialSize?.width ?? 0;
  const h = n.height ?? n.data?.initialSize?.height ?? 0;
  return { width: w, height: h };
}

/**
 * SHA-256 fingerprint over the cluster's geometry + strokes. Stable
 * under re-ordering of nodes (sort by id) but sensitive to any change
 * in position / size / stroke points / colour / thickness — which is
 * exactly what changes the rendered PNG. First 16 hex chars (~64 bits
 * of entropy) is plenty for per-canvas dedup.
 */
function clusterFingerprint(nodes: RawNode[]): string {
  const canonical = nodes
    .map((n) => {
      const { width, height } = sketchEffectiveSize(n);
      return {
        id: n.id,
        x: n.position?.x ?? 0,
        y: n.position?.y ?? 0,
        w: width,
        h: height,
        init: n.data?.initialSize ?? null,
        strokes: (n.data?.strokes ?? []).map((s) => ({
          c: s.color ?? null,
          z: s.size ?? null,
          p: s.points,
        })),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Build a complete SVG document from a cluster of sketch nodes.
 *
 * Every stroke is transformed into **world coordinates** (i.e. each
 * point is multiplied by the node's `effectiveSize / initialSize` and
 * offset by the node's `position`), so the parent SVG can declare
 * `viewBox = clusterBbox` and any number of stroke nodes share one
 * coordinate system. The output PNG faithfully reproduces the spatial
 * relationship between the contributing strokes — exactly what
 * `sketchToImage.ts` used to do client-side.
 *
 * Returns `null` when the cluster contributes no painted area (no
 * strokes anywhere, or every node has zero size) so callers can drop
 * it without surfacing a misleading 1×1 PNG.
 */
function clusterToSvg(
  nodes: RawNode[],
): { svg: string; width: number; height: number } | null {
  // World bbox = union of every contributing node's rect.
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const n of nodes) {
    const { width, height } = sketchEffectiveSize(n);
    if (width <= 0 || height <= 0) continue;
    const px = n.position?.x ?? 0;
    const py = n.position?.y ?? 0;
    x1 = Math.min(x1, px);
    y1 = Math.min(y1, py);
    x2 = Math.max(x2, px + width);
    y2 = Math.max(y2, py + height);
  }
  if (!isFinite(x1) || !isFinite(y1)) return null;
  const bboxW = x2 - x1;
  const bboxH = y2 - y1;
  if (bboxW <= 0 || bboxH <= 0) return null;

  const vbX = x1 - CLUSTER_PADDING;
  const vbY = y1 - CLUSTER_PADDING;
  const vbW = bboxW + CLUSTER_PADDING * 2;
  const vbH = bboxH + CLUSTER_PADDING * 2;

  // Fit-to-CLUSTER_MAX_PIXELS so very large clusters do not produce
  // multi-megabyte PNGs.
  const scale = Math.min(1, CLUSTER_MAX_PIXELS / Math.max(vbW, vbH));
  const pxW = Math.max(1, Math.round(vbW * scale));
  const pxH = Math.max(1, Math.round(vbH * scale));

  const innerPaths: string[] = [];
  let anyStrokes = false;
  for (const n of nodes) {
    const strokes = n.data?.strokes ?? [];
    if (strokes.length === 0) continue;
    const init = n.data?.initialSize ?? { width: 1, height: 1 };
    const { width, height } = sketchEffectiveSize(n);
    // Same point transform the on-canvas renderer uses: scale points by
    // (current size / initial size) but keep stroke thickness untouched.
    const scaleX = init.width > 0 ? width / init.width : 1;
    const scaleY = init.height > 0 ? height / init.height : 1;
    const ox = n.position?.x ?? 0;
    const oy = n.position?.y ?? 0;
    for (const stroke of strokes) {
      const pts = stroke.points;
      if (!pts || pts.length === 0) continue;
      const worldPoints = pts.map((pt) => [
        pt[0] * scaleX + ox,
        pt[1] * scaleY + oy,
        pt[2] ?? 0.5,
      ]);
      const colorToken = stroke.color || DEFAULT_STROKE_COLOR;
      // Tokens like 'red' / 'blue' map through the accent palette;
      // anything else (hex literals, named CSS colours like 'black')
      // passes through unchanged.
      const fill = resolveAccent(colorToken) ?? colorToken;
      const size = stroke.size ?? DEFAULT_STROKE_SIZE;
      const d = pointsToPathD(worldPoints, size);
      if (!d) continue;
      innerPaths.push(`<path d="${d}" fill="${escapeXml(fill)}" />`);
      anyStrokes = true;
    }
  }
  if (!anyStrokes) return null;

  // White background so the rasterized sketch looks like paper rather
  // than a transparent void when the AI receives it.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${pxW}" height="${pxH}">` +
    `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="#ffffff" />` +
    innerPaths.join('') +
    `</svg>`;
  return { svg, width: pxW, height: pxH };
}

/**
 * Bucket sketch nodes by their `parentId` and run single-linkage
 * spatial clustering inside each bucket. Two sketches that overlap in
 * flow space but live in different frames stay in separate clusters —
 * the user's mental model is that a frame is an explicit container, so
 * an "accidental overlap" across frames should not collapse two
 * separate gestures into one picture.
 */
function clusterSketchesByFrame(nodes: RawNode[]): RawNode[][] {
  const buckets = new Map<string, RawNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? '__root__';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(n);
    else buckets.set(key, [n]);
  }

  // findClusters wants `SpatialNode` ({ id, rect }). Build thin shims
  // that wrap each RawNode so we can recover the original after.
  type Shim = SpatialNode & { node: RawNode };
  const out: RawNode[][] = [];
  for (const bucket of buckets.values()) {
    const shims: Shim[] = bucket.map((n) => {
      const { width, height } = sketchEffectiveSize(n);
      return {
        id: n.id,
        rect: {
          x: n.position?.x ?? 0,
          y: n.position?.y ?? 0,
          width,
          height,
        },
        node: n,
      };
    });
    // `findClusters` uses strict `<` so bump the threshold by 1 to
    // match the web pipeline's historical `<=` semantics.
    const groups = findClusters(shims, CLUSTER_DISTANCE_THRESHOLD + 1);
    for (const group of groups) {
      if (group.length > 0) out.push(group.map((g) => g.node));
    }
  }
  return out;
}

async function renderClusterPng(svg: string, width: number): Promise<Buffer> {
  await ensureResvgReady();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: '#ffffff',
  });
  return Buffer.from(resvg.render().asPng());
}

// ─── Handler ───────────────────────────────────────────────────────────────
/**
 * Typed internal API. Returns the parsed result array directly so
 * callers (e.g. `agent.route.ts`) don't have to JSON-parse it back.
 * The tool-facing {@link handleRasterizeNodes} wraps this in
 * `JSON.stringify`.
 */
export async function rasterizeNodesToArtifacts(
  args: RasterizeNodesArgs,
): Promise<RasterizeNodeResult[]> {
  const ids = args.nodeIds ?? [];
  if (ids.length === 0) return [];

  const store = getCanvasStore(args.canvasId);
  const canvas = store.read();
  if (!canvas) {
    throw new Error(`Canvas ${args.canvasId} not found`);
  }
  const allNodes = (canvas.state.nodes ?? []) as RawNode[];
  const byId = new Map(allNodes.map((n) => [n.id, n] as const));

  // Dedup ids while preserving first-seen order so the result reads
  // like the request did.
  const seenIds = new Set<string>();
  const orderedIds: string[] = [];
  for (const id of ids) {
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    orderedIds.push(id);
  }

  const results: RasterizeNodeResult[] = [];
  const sketchNodes: RawNode[] = [];

  for (const id of orderedIds) {
    const node = byId.get(id);
    if (!node) {
      throw new Error(`Node ${id} not found on canvas ${args.canvasId}.`);
    }
    const type = node.data?.type;

    if (type === 'image' || type === 'video') {
      const src = node.data?.src;
      if (!src) {
        throw new Error(
          `Node ${id} (${type}) has no src — nothing to rasterize. The artifact may have been deleted.`,
        );
      }
      results.push({ src, width: 0, height: 0, originNodeIds: [id] });
      continue;
    }
    if (type === 'pdf') {
      const cover = node.data?.coverUrl;
      if (!cover) {
        throw new Error(
          `PDF node ${id} has no cover image. Open the node and capture a cover first, or rasterize a different node.`,
        );
      }
      results.push({ src: cover, width: 0, height: 0, originNodeIds: [id] });
      continue;
    }
    if (type === 'sketch') {
      sketchNodes.push(node);
      continue;
    }
    if (type === 'note' || type === 'text') {
      throw new Error(
        `Node ${id} is a ${type} node. Rasterizing text is wasteful — use \`read("nodes/<file>.md")\` to fetch its content and weave that into your image prompt instead.`,
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

  // ── Sketches: cluster, render, content-address ────────────────────────
  if (sketchNodes.length > 0) {
    const clusters = clusterSketchesByFrame(sketchNodes);
    for (const cluster of clusters) {
      const built = clusterToSvg(cluster);
      const originNodeIds = cluster.map((n) => n.id);
      if (!built) {
        // Empty cluster (no strokes / zero area). Skip silently —
        // emitting a 1×1 placeholder would just confuse the model.
        continue;
      }
      const fingerprint = clusterFingerprint(cluster);
      // `sketch-raster-<hash>.png` — the `sketch-raster-` prefix makes
      // these recognisable in `.artifacts/` listings and the hash
      // gives deterministic content-addressed dedup.
      const id = `sketch-raster-${fingerprint}`;
      const filename = `${id}.png`;
      const existing = store.resolveArtifactFilePath(filename);
      if (!existing) {
        const png = await renderClusterPng(built.svg, built.width);
        await store.writeArtifactBuffer(
          { id, ext: '.png', mimeType: 'image/png' },
          png,
        );
      }
      results.push({
        src: filename,
        width: built.width,
        height: built.height,
        originNodeIds,
      });
    }
  }

  return results;
}

/** Tool-facing handler — same logic, JSON-stringified. */
export async function handleRasterizeNodes(
  args: RasterizeNodesArgs,
): Promise<string> {
  const results = await rasterizeNodesToArtifacts(args);
  return JSON.stringify(results);
}
