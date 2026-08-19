// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Produce PNG snapshots of canvas nodes.
 *
 * The tool snapshots **only the nodes the caller asked for**. It
 * never reaches into `allNodes` to grab uninvited neighbours.
 *
 * Pipeline (one rule for every snapshottable node, no special cases
 * for image-vs-sketch):
 *
 *   1. `frame` ids are recursively expanded into their children;
 *      non-snapshottable children are silently dropped.
 *   2. The resulting `image` + `sketch` nodes are bucketed by
 *      `parentId` and single-linkage clustered in flow space
 *      (200 px edge-to-edge). Cross-frame overlaps never merge —
 *      a frame is an explicit container in the user's mental model.
 *   3. Each cluster becomes ONE PNG: image members are drawn at
 *      their world-space rect as backdrop and sketch strokes are
 *      layered on top, all sharing one `viewBox` so the artifact
 *      preserves the on-canvas spatial relationships.
 *   4. A singleton image cluster short-circuits: instead of
 *      re-rastering, the node's existing artifact key is returned
 *      as-is (or a content-addressed downscaled copy when its
 *      longest edge exceeds `maxPixels`).
 *
 * Out of scope (each yields a clear error directing the caller to a
 * better path):
 *   - `note` / `text` / `pdf` — read `nodes/<file>.md` and weave the
 *                               sidecar content into the prompt instead.
 *   - `video`           — not a still image; gpt-image-1 can't use it.
 *   - `audio` / `web` / `office` / `question` — no meaningful snapshot.
 *
 * Rendered cluster snapshots are **content-addressed**: the artifact
 * filename embeds a SHA-256 fingerprint of every member's geometry +
 * strokes + backdrop bytes, so re-snapshotting an unchanged input
 * returns the same `src` without writing a new file. This keeps
 * `.artifacts/` bounded under the chat-route auto-snapshot path that
 * runs on every send.
 *
 * Returns `Array<{src, width, height, originNodeIds}>`.
 * `originNodeIds` lists every node that contributed pixels to that
 * artifact — a multi-member cluster lists all stroke + backdrop image
 * ids; a singleton image pass-through lists its single id.
 *
 * The built-in tool and direct Space query both call
 * {@link snapshotNodesToArtifacts}; rendering and materialization have
 * one canonical implementation.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import getStrokeImport from 'perfect-freehand';

import {
  SPACE_SNAPSHOT_DEFAULT_PIXELS,
  SPACE_SNAPSHOT_MAX_PIXELS,
  SPACE_SNAPSHOT_MIN_PIXELS,
  findClusters,
  resolveAccent,
} from '@huabu/shared';
import { getSketchRenderedSize } from '@huabu/shared/canvas-engine';

import { RASTERIZABLE_IMAGE_EXT_MIME } from '../../utils/mime.js';
import { space } from '../storage/index.js';

import type { Space } from '../storage/index.js';
import type {
  SketchNodeData,
  SnapshotNodesQueryParams,
  SpatialNode,
} from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

type GetStroke = (typeof getStrokeImport)['default'];

const getStroke = (
  typeof getStrokeImport === 'function'
    ? getStrokeImport
    : (getStrokeImport as { default: GetStroke }).default
) as GetStroke;

export type SnapshotNodesArgs = SnapshotNodesQueryParams & {
  canvasId: string;
};

/** Typed shape of one entry in the JSON result array. */
export interface SnapshotNodeResult {
  /** Artifact key — bare filename like `<id>.png`, ready for `data.src`. */
  src: string;
  /** Width in PNG pixels (0 = unknown, e.g. for pass-through). */
  width: number;
  /** Height in PNG pixels (0 = unknown, e.g. for pass-through). */
  height: number;
  /** Canvas node ids that contributed to this artifact. */
  originNodeIds: string[];
}

export class SnapshotNodeError extends Error {
  constructor(
    message: string,
    readonly code: 'canvas_not_found' | 'invalid_snapshot_request',
  ) {
    super(message);
    this.name = 'SnapshotNodeError';
  }
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
// Padding around the cluster bbox (flow-space units).
const CLUSTER_PADDING = 16;
// Max PNG dimension. Clusters larger than this are scaled to fit.
// Kept at 1280 because:
//   1. The output is lossless PNG (resvg-wasm has no JPEG encoder),
//      and the bytes scale ~linearly with pixel count. A 1878×1790
//      cluster at 2048 px produced a 3.6 MB PNG in the wild and
//      tipped one thread over the upstream LLM's 8 MB request-body
//      limit (Anthropic / Copilot return 413 around there).
//   2. Every vision provider we target downscales to ≤1024–1568 on
//      the long edge internally, so anything above ~1280 is wasted
//      bytes on the request, not on the model's actual input.
//   3. 1280 still leaves enough resolution for `gpt-image-1` to use
//      the cluster as a reference image without visible blur.
const CLUSTER_MAX_PIXELS = SPACE_SNAPSHOT_DEFAULT_PIXELS;
// Edge-to-edge clustering threshold (flow-space px).
const CLUSTER_DISTANCE_THRESHOLD = 200;

// ─── Node `data` access (loose, defensive) ─────────────────────────────────
// Top-level node fields come from {@link CanvasNode} (= ReactFlow `Node`):
// `id`, `type`, `position`, `parentId`, `measured`, `style`, `data`. The
// canvas engine (see `createNodes.ts`) persists size into `style.width` /
// `style.height`; ReactFlow writes `measured.{width,height}` at render
// time. Top-level `node.width` / `node.height` are **never** written by
// the engine, so we do not consult them here.
//
// Topology is geometry/style only: content keys on `data`
// (`content` / `label` / `labelSource` / `src` / `summary` / `keywords` /
// `provenance`) are stripped by `stripNodesForCanvas` before write and
// re-hydrated from the markdown sidecar on read. Sketch nodes are the
// exception: their `strokes` + `initialSize` live in topology and
// match {@link SketchNodeData} exactly. We read it as a `Partial<…>`
// because persisted JSON may be missing fields on
// legacy or in-flight nodes.

/**
 * Read a sketch node's payload as a partial of the canonical
 * {@link SketchNodeData}. Returns `undefined` when `data` is missing.
 * Read `src` for image-like nodes via {@link readSidecarString} — image
 * `src` is never present in `data`.
 */
function getSketchData(n: CanvasNode): Partial<SketchNodeData> | undefined {
  return n.data as Partial<SketchNodeData> | undefined;
}

/**
 * Read the node-type tag, preferring ReactFlow's canonical top-level
 * `node.type` and falling back to the legacy `data.type` field that
 * older canvases may still carry.
 */
function getNodeType(n: CanvasNode): string | undefined {
  if (typeof n.type === 'string') return n.type;
  const legacy = (n.data as { type?: unknown } | undefined)?.type;
  return typeof legacy === 'string' ? legacy : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = Number.parseFloat(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readStyle(
  n: CanvasNode,
): { width?: number | string; height?: number | string } | undefined {
  return n.style as
    | { width?: number | string; height?: number | string }
    | undefined;
}

/**
 * Read a node's effective on-canvas size for non-sketch nodes (images
 * etc.). Priority `measured` (browser-truth) → `style` (engine-persisted
 * size from `CREATE_NODES`), mirroring the web
 * `node.measured?.width ?? node.style?.width` chain used throughout
 * the renderer. Top-level `n.width` / `n.height` is never persisted
 * by the canvas engine so it is intentionally not consulted.
 */
function nodeBoxSize(n: CanvasNode): { width: number; height: number } {
  const style = readStyle(n);
  const w = num(n.measured?.width) ?? num(style?.width) ?? 0;
  const h = num(n.measured?.height) ?? num(style?.height) ?? 0;
  return { width: w, height: h };
}

// ─── Resvg WASM init ───────────────────────────────────────────────────────
// initWasm() must run exactly once before any Resvg constructor call.
// We lazy-init on first use and memoise the promise so concurrent
// snapshot calls (e.g. agent snapshotting 3 sketches in parallel) all
// await the same init.
let wasmInitPromise: Promise<void> | null = null;

export function bundledResvgWasmPath(
  moduleUrl: string | URL,
  platform: NodeJS.Platform = process.platform,
): string {
  const windows = platform === 'win32';
  const pathImpl = windows ? path.win32 : path.posix;
  return pathImpl.join(
    pathImpl.dirname(fileURLToPath(moduleUrl, { windows })),
    'resvg-bg.wasm',
  );
}

async function ensureResvgReady(): Promise<void> {
  if (wasmInitPromise) return wasmInitPromise;
  wasmInitPromise = (async () => {
    // Try dev path first (resolves through node_modules), fall back to
    // bundle path (sibling of the bundled server.js). The bundle copy
    // is performed by tsup.config.ts's onSuccess hook.
    let wasmBytes: Buffer | null = null;
    try {
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm');
      wasmBytes = await readFile(wasmPath);
    } catch {
      // Bundle path
      const wasmPath = bundledResvgWasmPath(import.meta.url);
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
 * Effective on-canvas size for a sketch node. Thin server-side alias for
 * the shared {@link getSketchRenderedSize}: the persisted `CanvasNode` is
 * structurally a ReactFlow node, so the shared reader's superset chain
 * (`measured → node.width → style → initialSize → 0`) already selects the
 * right source here — the engine only ever populates `measured` / `style`,
 * so the `node.width` tier is a no-op on the server. Kept as a named
 * wrapper so call sites read intent and the sketch-only `initialSize`
 * fallback stays documented at the point of use.
 */
function sketchEffectiveSize(n: CanvasNode): {
  width: number;
  height: number;
} {
  return getSketchRenderedSize(n);
}

/**
 * Return a shallow-cloned sketch node whose `data.strokes` is narrowed
 * to `keep` (the caller-requested stroke id subset), preserving the
 * node's original stroke order and every other field (position, size,
 * initialSize) so the whole downstream pipeline — clustering, bbox,
 * fingerprint, render — treats it exactly like a full node with fewer
 * strokes. The content-address fingerprint hashes stroke points, so the
 * subset render is automatically distinct from the whole-node render.
 *
 * Returns the original node when `keep` already covers every stroke. A
 * non-empty KEEP-list that matches nothing is rejected instead of silently
 * widening the requested context to the full sketch.
 */
export function filterSketchStrokes(
  node: CanvasNode,
  keep: Set<string>,
): CanvasNode {
  const strokes = getSketchData(node)?.strokes ?? [];
  if (strokes.length === 0) return node;
  const filtered = strokes.filter((s) => keep.has(s.id));
  if (filtered.length === 0) {
    throw new SnapshotNodeError(
      `None of the requested stroke ids exist on sketch node ${node.id}. The stroke selection may be stale; ask the user to select the strokes again.`,
      'invalid_snapshot_request',
    );
  }
  if (filtered.length === strokes.length) return node;
  return {
    ...node,
    data: { ...(node.data as Record<string, unknown>), strokes: filtered },
  } as CanvasNode;
}

/**
 * SHA-256 fingerprint over the cluster's geometry + strokes plus any
 * backdrop image nodes composited under the strokes. Stable under
 * re-ordering of nodes (sort by id) but sensitive to any change in
 * position / size / stroke points / colour / thickness / backdrop
 * src — which is exactly what changes the rendered PNG. First 16 hex
 * chars (~64 bits of entropy) is plenty for per-canvas dedup.
 */
function clusterFingerprint(
  nodes: CanvasNode[],
  contextImages: ContextImage[] = [],
): string {
  const sketches = nodes
    .map((n) => {
      const { width, height } = sketchEffectiveSize(n);
      const data = getSketchData(n);
      return {
        id: n.id,
        x: n.position?.x ?? 0,
        y: n.position?.y ?? 0,
        w: width,
        h: height,
        init: data?.initialSize ?? null,
        strokes: (data?.strokes ?? []).map((s) => ({
          c: s.color ?? null,
          z: s.size ?? null,
          p: s.points,
        })),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const context = contextImages
    .map((ci) => ({
      id: ci.node.id,
      src: ci.resolvedSrc,
      x: ci.node.position?.x ?? 0,
      y: ci.node.position?.y ?? 0,
      w: ci.width,
      h: ci.height,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256')
    .update(JSON.stringify({ sketches, context }))
    .digest('hex')
    .slice(0, 16);
}

// ─── Image artifact MIME map ───────────────────────────────────────────────
// Used by `maybeResizeImageArtifact` to wrap raw image bytes inside an
// SVG `<image>` element for resvg-driven downscaling, and by
// `loadContextImage` to pick a base64 MIME for the backdrop embed.
// Anything outside this map (webp / svg / avif) is left at its original
// size and is skipped for backdrop compositing — the sketch still
// renders, just without that backdrop.
const IMAGE_EXT_MIME = RASTERIZABLE_IMAGE_EXT_MIME;

/**
 * Read a non-empty string value from a node's markdown sidecar
 * frontmatter. The sidecar is the canonical (and sole) home for
 * `src` on artifact-backed nodes — see the note above {@link SketchData}.
 * Returns `null` when the node has no sidecar or the key is
 * missing/blank.
 */
async function readSidecarString(
  handle: Space,
  nodeId: string,
  key: 'src',
): Promise<string | null> {
  const record = (await handle.nodes.read(nodeId))?.record;
  if (!record) return null;
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * An image node loaded into memory, ready to be composited under a
 * sketch cluster as a backdrop in the snapshot PNG.
 */
export interface ContextImage {
  node: CanvasNode;
  /** Artifact key actually used to load the bytes (sidecar `src`). */
  resolvedSrc: string;
  bytes: Buffer;
  mimeType: string;
  /** On-canvas width — resolved via {@link nodeBoxSize}. */
  width: number;
  /** On-canvas height — resolved via {@link nodeBoxSize}. */
  height: number;
}

/**
 * Load an image node's bytes from the artifact store and pack into a
 * {@link ContextImage}. Returns `null` when the node has no resolvable
 * src, the artifact file is missing, the format is unsupported by
 * resvg, or the node has no measurable size on canvas — in any of
 * those cases the caller proceeds without backdrop compositing for
 * this image.
 */
async function loadContextImage(
  handle: Space,
  node: CanvasNode,
): Promise<ContextImage | null> {
  const src = await readSidecarString(handle, node.id, 'src');
  if (!src) return null;
  const ext = path.extname(src).toLowerCase();
  const mimeType = IMAGE_EXT_MIME[ext];
  if (!mimeType) return null;
  const { width, height } = nodeBoxSize(node);
  if (width <= 0 || height <= 0) return null;
  const bytes = await handle.blobs.read(src);
  if (!bytes) return null;
  return { node, resolvedSrc: src, bytes, mimeType, width, height };
}

/**
 * Build a complete SVG document from a cluster of sketch nodes,
 * optionally composited over backdrop image nodes the caller also
 * passed in.
 *
 * Every stroke is transformed into **world coordinates** (i.e. each
 * point is multiplied by the node's `effectiveSize / initialSize` and
 * offset by the node's `position`), so the parent SVG can declare
 * `viewBox = clusterBbox` and any number of stroke nodes share one
 * coordinate system. The output PNG faithfully reproduces the spatial
 * relationship between the contributing strokes — exactly what
 * `sketchToImage.ts` used to do client-side.
 *
 * Backdrop images are placed at their on-canvas world rect with
 * `preserveAspectRatio="xMidYMid meet"`, mirroring the web
 * `<img className="object-contain" />` so the strokes land on the
 * same pixels the user saw when drawing them. The viewBox is unioned
 * with each backdrop rect so context around the strokes stays visible
 * even when only a small region was circled.
 *
 * Returns `null` when the cluster contributes no painted area (no
 * strokes anywhere AND no loadable backdrop images, or every node has
 * zero size) so callers can drop it without surfacing a misleading
 * 1×1 PNG.
 */
export function clusterToSvg(
  nodes: CanvasNode[],
  contextImages: ContextImage[] = [],
  maxEdge: number = CLUSTER_MAX_PIXELS,
): { svg: string; width: number; height: number } | null {
  // World bbox = union of every contributing sketch + backdrop rect.
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
  for (const ci of contextImages) {
    if (ci.width <= 0 || ci.height <= 0) continue;
    const px = ci.node.position?.x ?? 0;
    const py = ci.node.position?.y ?? 0;
    x1 = Math.min(x1, px);
    y1 = Math.min(y1, py);
    x2 = Math.max(x2, px + ci.width);
    y2 = Math.max(y2, py + ci.height);
  }
  if (!isFinite(x1) || !isFinite(y1)) return null;
  const bboxW = x2 - x1;
  const bboxH = y2 - y1;
  if (bboxW <= 0 || bboxH <= 0) return null;

  const vbX = x1 - CLUSTER_PADDING;
  const vbY = y1 - CLUSTER_PADDING;
  const vbW = bboxW + CLUSTER_PADDING * 2;
  const vbH = bboxH + CLUSTER_PADDING * 2;

  // Fit-to-`maxEdge` so very large clusters do not produce
  // multi-megabyte PNGs. Defaults to `CLUSTER_MAX_PIXELS` (1280);
  // the agent can lower it via the tool's `maxPixels` parameter
  // when a previous turn returned an "image too large" placeholder.
  const scale = Math.min(1, maxEdge / Math.max(vbW, vbH));
  const pxW = Math.max(1, Math.round(vbW * scale));
  const pxH = Math.max(1, Math.round(vbH * scale));

  const backdrops: string[] = [];
  for (const ci of contextImages) {
    if (ci.width <= 0 || ci.height <= 0) continue;
    const ix = ci.node.position?.x ?? 0;
    const iy = ci.node.position?.y ?? 0;
    const href = `data:${ci.mimeType};base64,${ci.bytes.toString('base64')}`;
    backdrops.push(
      `<image x="${ix}" y="${iy}" width="${ci.width}" height="${ci.height}" ` +
        `preserveAspectRatio="xMidYMid meet" href="${href}" />`,
    );
  }

  const innerPaths: string[] = [];
  let anyStrokes = false;
  for (const n of nodes) {
    const data = getSketchData(n);
    const strokes = data?.strokes ?? [];
    if (strokes.length === 0) continue;
    const init = data?.initialSize ?? { width: 1, height: 1 };
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
  if (!anyStrokes && backdrops.length === 0) return null;

  // White background under everything: matches the canvas surface
  // (and fills any object-contain letterbox around backdrops).
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${pxW}" height="${pxH}">` +
    `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="#ffffff" />` +
    backdrops.join('') +
    innerPaths.join('') +
    `</svg>`;
  return { svg, width: pxW, height: pxH };
}

/**
 * One snapshottable node tagged with whether it came in directly or
 * via a `frame` expansion. `fromFrame` controls error leniency: a
 * direct id with a missing src throws (the caller asked for it
 * explicitly); the same node swept in via a frame is silently dropped.
 */
interface SnapshotEntry {
  node: CanvasNode;
  /** 'image' or 'sketch' — pre-resolved via {@link getNodeType}. */
  type: 'image' | 'sketch';
  fromFrame: boolean;
}

/**
 * Bucket snapshottable nodes (image + sketch alike) by their
 * `parentId` and run single-linkage spatial clustering inside each
 * bucket. Two nodes that overlap in flow space but live in different
 * frames stay in separate clusters — the user's mental model is that
 * a frame is an explicit container, so an "accidental overlap" across
 * frames should not collapse two separate gestures into one picture.
 *
 * Image and sketch nodes go through the same pipeline: any
 * proximity-bound mix (image+image, image+sketch, sketch+sketch)
 * becomes a single composite cluster.
 */
function clusterByFrame(entries: SnapshotEntry[]): SnapshotEntry[][] {
  const buckets = new Map<string, SnapshotEntry[]>();
  for (const e of entries) {
    const key = e.node.parentId ?? '__root__';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(e);
    else buckets.set(key, [e]);
  }

  // findClusters wants `SpatialNode` ({ id, rect }). Build thin shims
  // that wrap each entry so we can recover the original after.
  type Shim = SpatialNode & { entry: SnapshotEntry };
  const out: SnapshotEntry[][] = [];
  for (const bucket of buckets.values()) {
    const shims: Shim[] = bucket.map((e) => {
      // Sketches need `sketchEffectiveSize` (it falls back to
      // `data.initialSize` on first paint before xyflow writes
      // `measured`); images only ever carry `measured` / `style`.
      const { width, height } =
        e.type === 'sketch' ? sketchEffectiveSize(e.node) : nodeBoxSize(e.node);
      return {
        id: e.node.id,
        rect: {
          x: e.node.position?.x ?? 0,
          y: e.node.position?.y ?? 0,
          width,
          height,
        },
        entry: e,
      };
    });
    // `findClusters` uses strict `<` so bump the threshold by 1 to
    // match the web pipeline's historical `<=` semantics.
    const groups = findClusters(shims, CLUSTER_DISTANCE_THRESHOLD + 1);
    for (const group of groups) {
      if (group.length > 0) out.push(group.map((g) => g.entry));
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

// ─── Image dimension parsing ───────────────────────────────────────────────
// Minimal PNG + JPEG header readers used by the image-downscale path
// below. We deliberately avoid a heavyweight `image-size` dependency:
// the formats we need to size are exactly the ones our snapshot
// pipeline + canvas image inputs produce, and both lay their pixel
// dimensions in a fixed prefix that's a few bytes to read.

function readPngDimensions(
  buf: Buffer,
): { width: number; height: number } | null {
  // PNG: 8-byte signature + 4-byte IHDR length + 4-byte 'IHDR' +
  // 4-byte width + 4-byte height. All big-endian.
  if (buf.length < 24) return null;
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47
  ) {
    return null;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function readJpegDimensions(
  buf: Buffer,
): { width: number; height: number } | null {
  // JPEG: SOI (FF D8), then a sequence of segments. Each non-SOI/EOI
  // segment is `FF <marker> <2-byte length>`. SOFn markers (`C0..CF`
  // except `C4` DHT, `C8` reserved, `CC` DAC) hold pixel dimensions:
  // after the segment length, byte 0 is precision, bytes 1-2 height,
  // bytes 3-4 width (big-endian).
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length) {
    // Skip 0xFF fill bytes.
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) return null;
    const marker = buf[i++];
    // Standalone markers (no length): RSTn, SOI, EOI, TEM.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      continue;
    }
    if (i + 1 >= buf.length) return null;
    const segLen = buf.readUInt16BE(i);
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      // SOFn — height @ +3, width @ +5 from segLen start.
      if (i + 7 >= buf.length) return null;
      const height = buf.readUInt16BE(i + 3);
      const width = buf.readUInt16BE(i + 5);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    i += segLen;
  }
  return null;
}

function readImageDimensions(
  buf: Buffer,
  mimeType: string,
): { width: number; height: number } | null {
  if (mimeType === 'image/png') return readPngDimensions(buf);
  if (mimeType === 'image/jpeg') return readJpegDimensions(buf);
  // gif / webp / etc. — not common enough on the canvas to be worth
  // a parser today. Falling back to `null` here means the image is
  // returned unchanged (the original artifact src), which matches
  // the pre-`maxPixels` behaviour.
  return null;
}

/**
 * Re-rasterize a loaded image at a smaller `maxEdge`. Uses resvg-wasm
 * (already a dep for sketch rendering) by wrapping the image bytes in
 * a thin SVG. Returns a PNG `Buffer` and the new dimensions.
 *
 * Caller must have established that `Math.max(width, height) > maxEdge`
 * — we never upscale.
 */
async function resampleImageBytes(
  bytes: Buffer,
  mimeType: string,
  origWidth: number,
  origHeight: number,
  maxEdge: number,
): Promise<{ png: Buffer; width: number; height: number }> {
  await ensureResvgReady();
  const scale = maxEdge / Math.max(origWidth, origHeight);
  const newW = Math.max(1, Math.round(origWidth * scale));
  const newH = Math.max(1, Math.round(origHeight * scale));
  const href = `data:${mimeType};base64,${bytes.toString('base64')}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="0 0 ${origWidth} ${origHeight}" width="${newW}" height="${newH}">` +
    `<image x="0" y="0" width="${origWidth}" height="${origHeight}" ` +
    `preserveAspectRatio="none" href="${href}" />` +
    `</svg>`;
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: newW },
    background: 'rgba(0,0,0,0)',
  });
  return {
    png: Buffer.from(resvg.render().asPng()),
    width: newW,
    height: newH,
  };
}

/**
 * If the artifact at `src` is larger than `maxEdge` on its longest
 * side, write a downscaled PNG copy and return its key + new
 * dimensions. Otherwise (already small enough, missing file, or
 * unsupported format) returns `null` so the caller can fall back to
 * the original artifact unchanged.
 *
 * Downscaled output is content-addressed by `<originalKey>-<maxEdge>`
 * so repeated calls with the same parameters are O(1) cache hits.
 */
async function maybeResizeImageArtifact(
  handle: Space,
  src: string,
  maxEdge: number,
): Promise<{ src: string; width: number; height: number } | null> {
  const blobs = handle.blobs;
  const ext = path.extname(src).toLowerCase();
  const mimeType = IMAGE_EXT_MIME[ext];
  if (!mimeType) return null;
  const bytes = await blobs.read(src);
  if (!bytes) return null;
  const dims = readImageDimensions(bytes, mimeType);
  if (!dims) return null;
  if (Math.max(dims.width, dims.height) <= maxEdge) return null;

  // Content-address: <originalStem>-resized-<edge>.png. Keeping the
  // original stem in the filename makes the lineage obvious when
  // browsing the artifact scope and prevents collisions across nodes.
  const originalStem = path.basename(src, path.extname(src));
  const id = `${originalStem}-resized-${maxEdge}`;
  const filename = `${id}.png`;
  const cachedBytes = await blobs.read(filename);
  if (cachedBytes) {
    // Re-derive dimensions from the cached blob so the result is
    // accurate without paying for another resvg pass.
    const cachedDims = readPngDimensions(cachedBytes);
    if (cachedDims) {
      return {
        src: filename,
        width: cachedDims.width,
        height: cachedDims.height,
      };
    }
    // Fall through and re-render below.
  }
  const resized = await resampleImageBytes(
    bytes,
    mimeType,
    dims.width,
    dims.height,
    maxEdge,
  );
  await blobs.put(filename, resized.png);
  return { src: filename, width: resized.width, height: resized.height };
}

// ─── Handler ───────────────────────────────────────────────────────────────
/**
 * Materialize the requested visual projection as content-addressed
 * artifacts and return their metadata.
 */
export async function snapshotNodesToArtifacts(
  args: SnapshotNodesArgs,
): Promise<SnapshotNodeResult[]> {
  const ids = args.nodeIds ?? [];
  if (ids.length === 0) return [];

  // `maxPixels` is the longest-edge cap for all rasterized output.
  // The agent can lower this to recover from oversize-image errors;
  // we clamp into the schema range as a defence in depth so callers
  // bypassing the schema can't request a 1×1 or a 1 GB PNG.
  const maxEdge = Math.max(
    SPACE_SNAPSHOT_MIN_PIXELS,
    Math.min(SPACE_SNAPSHOT_MAX_PIXELS, args.maxPixels ?? CLUSTER_MAX_PIXELS),
  );

  const handle = space(args.canvasId);
  const canvas = await handle.read();
  if (!canvas) {
    throw new SnapshotNodeError(
      `Canvas ${args.canvasId} not found`,
      'canvas_not_found',
    );
  }
  const allNodes = (canvas.state.nodes ?? []) as CanvasNode[];
  const byId = new Map(allNodes.map((n) => [n.id, n] as const));

  // Per-node stroke subset requested by the caller (partial-selection
  // snapshot). Keyed by node id; empty entries are dropped so a node
  // with no ids renders in full.
  const strokeSubsetMap = new Map<string, Set<string>>();
  for (const f of args.strokeSubsets ?? []) {
    if (f.strokeIds.length > 0) {
      strokeSubsetMap.set(f.nodeId, new Set(f.strokeIds));
    }
  }

  // Dedup ids while preserving first-seen order so the result reads
  // like the request did.
  const seenIds = new Set<string>();
  const orderedIds: string[] = [];
  for (const id of ids) {
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    orderedIds.push(id);
  }

  // Pre-expand any frame ids into their (non-frame) descendants. A
  // frame is a container — selecting one is a UX shortcut for
  // "snapshot what's inside this frame" — so we recursively walk its
  // children. `fromFrame` marks ids that were swept in via expansion
  // so the main loop can be lenient about non-snapshottable types
  // (note / text / pdf / video etc.) that happened to live inside the
  // frame: the caller wanted the visual whole, not an error about
  // each non-renderable child. Top-level ids still throw on
  // unsupported types so direct misuse stays loud.
  const expansion: Array<{ id: string; fromFrame: boolean }> = [];
  const expansionSeen = new Set<string>();
  const expand = (id: string, fromFrame: boolean): void => {
    if (expansionSeen.has(id)) return;
    const node = byId.get(id);
    if (!node) {
      if (fromFrame) return;
      throw new SnapshotNodeError(
        `Node ${id} not found on canvas ${args.canvasId}.`,
        'invalid_snapshot_request',
      );
    }
    if (getNodeType(node) === 'frame') {
      for (const child of allNodes) {
        if (child.parentId === id) expand(child.id, true);
      }
      return;
    }
    expansionSeen.add(id);
    expansion.push({ id, fromFrame });
  };
  for (const id of orderedIds) expand(id, false);

  const results: SnapshotNodeResult[] = [];
  // All snapshottable nodes (image + sketch) feed into the same
  // bucket-by-frame + spatial-cluster pipeline. There is no
  // image-only or sketch-only special path here — only a singleton
  // image cluster short-circuits below, to skip the SVG raster.
  const snapshottable: SnapshotEntry[] = [];

  for (const { id, fromFrame } of expansion) {
    // expansion only ever holds ids resolved via `byId`, so we can
    // safely re-read without an existence guard.
    const node = byId.get(id)!;
    const type = getNodeType(node);

    if (type === 'image' || type === 'sketch') {
      const keep = type === 'sketch' ? strokeSubsetMap.get(id) : undefined;
      const effective = keep ? filterSketchStrokes(node, keep) : node;
      snapshottable.push({ node: effective, type, fromFrame });
      continue;
    }
    // Non-snapshottable types coming via frame expansion are skipped
    // silently — the caller asked for the frame, not these children.
    if (fromFrame) continue;
    if (type === 'note' || type === 'text' || type === 'pdf') {
      throw new SnapshotNodeError(
        `Node ${id} is a ${type} node — it has no still image to convert. Use \`read("nodes/<file>.md")\` to fetch the sidecar (text, frontmatter, etc.) and weave that into your prompt instead.`,
        'invalid_snapshot_request',
      );
    }
    if (type === 'video') {
      throw new SnapshotNodeError(
        `Video node ${id} cannot be converted to a still image by this tool. If you need a frame, capture it on the canvas first; otherwise weave the node's sidecar content into your prompt via \`read("nodes/<file>.md")\`.`,
        'invalid_snapshot_request',
      );
    }
    throw new SnapshotNodeError(
      `Node type "${type ?? 'unknown'}" cannot be converted to an image. Supported: image, sketch, frame (expands to its children).`,
      'invalid_snapshot_request',
    );
  }

  if (snapshottable.length === 0) return results;

  const clusters = clusterByFrame(snapshottable);

  for (const cluster of clusters) {
    // ── Singleton image: pass-through (or maxPixels-resized copy) ──
    // Skipping the SVG raster here keeps the common "user asked
    // about one photo" case as cheap as a sidecar read + maybe one
    // resvg downscale, instead of building a full composite SVG.
    if (cluster.length === 1 && cluster[0].type === 'image') {
      const entry = cluster[0];
      const src = await readSidecarString(handle, entry.node.id, 'src');
      if (!src) {
        if (entry.fromFrame) continue;
        throw new SnapshotNodeError(
          `Node ${entry.node.id} (image) has no src — nothing to return. The artifact may have been deleted, or the node's markdown sidecar (nodes/<label>.md) is missing its \`src:\` frontmatter entry.`,
          'invalid_snapshot_request',
        );
      }
      const resized = await maybeResizeImageArtifact(handle, src, maxEdge);
      if (resized) {
        results.push({
          src: resized.src,
          width: resized.width,
          height: resized.height,
          originNodeIds: [entry.node.id],
        });
      } else {
        results.push({
          src,
          width: 0,
          height: 0,
          originNodeIds: [entry.node.id],
        });
      }
      continue;
    }

    // ── Composite cluster: render strokes over any loadable image
    //    backdrops as a single content-addressed PNG. ──────────────
    const sketchNodes: CanvasNode[] = [];
    const imageEntries: SnapshotEntry[] = [];
    for (const member of cluster) {
      if (member.type === 'sketch') sketchNodes.push(member.node);
      else imageEntries.push(member);
    }

    const contextImages: ContextImage[] = [];
    for (const entry of imageEntries) {
      const loaded = await loadContextImage(handle, entry.node);
      if (loaded) {
        contextImages.push(loaded);
        continue;
      }
      // Loadable means: sidecar src is set, file exists, format is
      // PNG / JPEG / GIF, and the node has a measurable on-canvas
      // size. A missing-src on a directly-requested node is the
      // only failure that should surface to the caller — frame
      // expansions and unsupported formats just drop silently
      // (the strokes will still render; losing one backdrop is
      // preferable to failing the whole batch).
      if (entry.fromFrame) continue;
      const src = await readSidecarString(handle, entry.node.id, 'src');
      if (!src) {
        throw new SnapshotNodeError(
          `Node ${entry.node.id} (image) has no src — nothing to return. The artifact may have been deleted, or the node's markdown sidecar (nodes/<label>.md) is missing its \`src:\` frontmatter entry.`,
          'invalid_snapshot_request',
        );
      }
    }

    const built = clusterToSvg(sketchNodes, contextImages, maxEdge);
    if (!built) {
      // Empty cluster — no strokes AND no loadable backdrops, or
      // every member has zero size. Nothing meaningful to emit.
      continue;
    }
    // `originNodeIds` lists every node whose pixels live in this
    // artifact — stroke ids + any backdrop image ids — so the
    // caller can correctly attribute the composite.
    const originNodeIds = [
      ...sketchNodes.map((n) => n.id),
      ...contextImages.map((ci) => ci.node.id),
    ];
    const fingerprint = clusterFingerprint(sketchNodes, contextImages);
    // `sketch-raster-<hash>-<edge>.png` — the prefix is kept for
    // historical compatibility with existing `.artifacts/` listings;
    // it now also covers image-only clusters that go through the
    // same SVG raster. The geometry hash + edge cap together give
    // deterministic content-addressed dedup that survives
    // `maxPixels` overrides (calling at 1280 then 768 produces two
    // distinct artifacts, not the second overwriting the first).
    const id =
      maxEdge === CLUSTER_MAX_PIXELS
        ? `sketch-raster-${fingerprint}`
        : `sketch-raster-${fingerprint}-${maxEdge}`;
    const filename = `${id}.png`;
    const existing = await handle.blobs.head(filename);
    if (!existing) {
      const png = await renderClusterPng(built.svg, built.width);
      await handle.blobs.put(filename, png);
    }
    results.push({
      src: filename,
      width: built.width,
      height: built.height,
      originNodeIds,
    });
  }

  return results;
}
