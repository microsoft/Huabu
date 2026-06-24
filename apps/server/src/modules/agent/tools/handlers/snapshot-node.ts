/**
 * `snapshot_nodes` handler — produce PNG snapshots of canvas nodes.
 *
 * Accepts a list of node ids and returns one artifact entry per group:
 *   - Each `image` node is a pass-through (its existing `data.src`
 *     artifact key is returned, no extra disk write).
 *   - `sketch` nodes are bucketed by `parentId` and then spatially
 *     clustered (single-linkage, 200 px threshold — same rule the web
 *     selection pipeline used to apply). Each cluster is rendered in
 *     **world coordinates** so multiple strokes share one SVG
 *     `viewBox` and the resulting PNG faithfully reproduces their
 *     spatial relationship on the canvas. The cluster is then
 *     rasterized via `@resvg/resvg-wasm`.
 *
 * Sketch snapshots are **content-addressed**: the artifact filename
 * embeds a SHA-256 fingerprint of the cluster's strokes + geometry.
 * Re-snapshotting an unchanged sketch returns the same `src` without
 * writing a new file, which prevents `.artifacts/` from exploding when
 * the agent route auto-snapshots selections on every send.
 *
 * Out of scope (each yields a clear error directing the caller to a
 * better path):
 *   - `note` / `text` / `pdf` — read `nodes/<file>.md` and weave the
 *                               sidecar content into the prompt instead.
 *   - `video`           — not a still image; gpt-image-1 can't use it.
 *   - `audio` / `web` / `office` / `question` — no meaningful snapshot.
 *
 * Selecting a `frame` is a UX shortcut for "snapshot what's inside this
 * frame": the handler recursively expands the frame to its children
 * (images + sketches contribute results, other child types are skipped
 * silently because the caller's intent was the visual whole, not each
 * non-renderable child).
 *
 * Returns a JSON-stringified `Array<{src, width, height, originNodeIds}>`.
 * `originNodeIds` lists every node that contributed to that artifact —
 * a sketch cluster of N strokes lists all N ids; a pass-through image
 * lists its single id.
 *
 * For internal callers (e.g. `agent.route.ts` auto-snapshotting the
 * user's sketch selection at chat send time) we also export
 * {@link snapshotNodesToArtifacts}, which returns the typed array
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

import type { snapshotNodesParamsSchema } from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';
import type { SketchNodeData, SpatialNode } from '@sediment/shared';
import type { CanvasNode } from '@sediment/shared/canvas-engine';

export type SnapshotNodesArgs = Static<typeof snapshotNodesParamsSchema> & {
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

// ─── Node `data` access (loose, defensive) ─────────────────────────────────
// Top-level node fields come from {@link CanvasNode} (= ReactFlow `Node`):
// `id`, `type`, `position`, `parentId`, `measured`, `style`, `data`. The
// canvas engine (see `createNodes.ts`) persists size into `style.width` /
// `style.height`; ReactFlow writes `measured.{width,height}` at render
// time. Top-level `node.width` / `node.height` are **never** written by
// the engine, so we do not consult them here.
//
// `canvas.json` is geometry/style only: content keys on `data`
// (`content` / `label` / `labelSource` / `src` / `summary` / `keywords` /
// `provenance`) are stripped by `stripNodesForCanvas` before write and
// re-hydrated from the markdown sidecar on read. Sketch nodes are the
// exception: their `strokes` + `initialSize` live in `canvas.json` and
// match {@link SketchNodeData} exactly. We read it as a `Partial<…>`
// because canvas.json is JSON-deserialized and may be missing fields on
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
 * `node.measured?.width ?? node.style?.width` chain used in
 * `SketchProcessingOverlay`, `sketchContext`, `intentStore`, etc.
 * Top-level `n.width` / `n.height` is never persisted by the canvas
 * engine so it is intentionally not consulted.
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
        path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
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
 * `measured` (reflects any user resize), then engine-persisted
 * `style.{width,height}`, then `data.initialSize`, then 0. The
 * `initialSize` fallback matters on first paint before xyflow has had
 * a chance to write `measured`.
 */
function sketchEffectiveSize(n: CanvasNode): {
  width: number;
  height: number;
} {
  const style = readStyle(n);
  const data = getSketchData(n);
  const w =
    num(n.measured?.width) ??
    num(style?.width) ??
    data?.initialSize?.width ??
    0;
  const h =
    num(n.measured?.height) ??
    num(style?.height) ??
    data?.initialSize?.height ??
    0;
  return { width: w, height: h };
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
    .map((ci) => {
      const { width, height } = nodeBoxSize(ci.node);
      return {
        id: ci.node.id,
        src: ci.resolvedSrc,
        x: ci.node.position?.x ?? 0,
        y: ci.node.position?.y ?? 0,
        w: width,
        h: height,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256')
    .update(JSON.stringify({ sketches, context }))
    .digest('hex')
    .slice(0, 16);
}

// ─── Context backdrop helpers ──────────────────────────────────────────────
/**
 * An image node loaded into memory, ready to be composited under a
 * sketch cluster as a backdrop in the snapshot PNG.
 */
export interface ContextImage {
  node: CanvasNode;
  /**
   * Artifact key actually used to load the bytes — may come from
   * `node.data.src` (canvas.json) or from the node's sidecar markdown
   * frontmatter (`nodes/<label>.md`). Image nodes only persist their
   * `src` in the sidecar; `canvas.json` keeps geometry/style only.
   */
  resolvedSrc: string;
  bytes: Buffer;
  mimeType: string;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/**
 * Image nodes that share the cluster's `parentId` and whose bbox
 * overlaps at least one sketch in the cluster. These are treated as
 * the visual backdrop the user drew the annotation over.
 *
 * Same-frame only: an "accidental" overlap across frame boundaries is
 * ignored, matching the cluster-by-frame rule used elsewhere in this
 * file.
 */
export function findContextImageNodes(
  cluster: CanvasNode[],
  allNodes: CanvasNode[],
): CanvasNode[] {
  if (cluster.length === 0) return [];
  const parentKey = cluster[0].parentId ?? null;
  const sketchRects: Rect[] = cluster
    .map((n) => {
      const { width, height } = sketchEffectiveSize(n);
      return {
        x: n.position?.x ?? 0,
        y: n.position?.y ?? 0,
        w: width,
        h: height,
      };
    })
    .filter((r) => r.w > 0 && r.h > 0);
  if (sketchRects.length === 0) return [];

  const out: CanvasNode[] = [];
  const seen = new Set<string>();
  for (const n of allNodes) {
    if ((n.parentId ?? null) !== parentKey) continue;
    if (getNodeType(n) !== 'image') continue;
    // NOTE: `data.src` is intentionally NOT checked here — image
    // nodes only persist their `src` in the sidecar markdown
    // (`nodes/<label>.md` frontmatter), so `canvas.json` always shows
    // `data.src === undefined`. `loadContextImage` is the layer that
    // resolves the real src (sidecar fallback) and drops candidates
    // whose artifact is missing or has an unsupported MIME.
    const { width: w, height: h } = nodeBoxSize(n);
    if (w <= 0 || h <= 0) continue;
    const rect: Rect = {
      x: n.position?.x ?? 0,
      y: n.position?.y ?? 0,
      w,
      h,
    };
    if (!sketchRects.some((s) => rectsOverlap(rect, s))) continue;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

// resvg supports PNG, JPEG, GIF embeds via <image href="data:..." />.
// Anything else (webp/svg/avif) is silently skipped: the sketch still
// renders, just without that backdrop.
const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

/**
 * Read a non-empty string value from a node's markdown sidecar
 * frontmatter. The sidecar is the canonical (and sole) home for
 * `src` on artifact-backed nodes — see the note above {@link SketchData}.
 * Returns `null` when the node has no sidecar or the key is
 * missing/blank.
 */
function readSidecarString(
  store: ReturnType<typeof getCanvasStore>,
  nodeId: string,
  key: 'src',
): string | null {
  const sidecar = store.readNode(nodeId);
  if (!sidecar) return null;
  const value = sidecar[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function loadContextImage(
  store: ReturnType<typeof getCanvasStore>,
  node: CanvasNode,
): Promise<ContextImage | null> {
  const src = readSidecarString(store, node.id, 'src');
  if (!src) return null;
  const abs = store.resolveArtifactFilePath(src);
  if (!abs) return null;
  const ext = path.extname(abs).toLowerCase();
  const mimeType = IMAGE_EXT_MIME[ext];
  if (!mimeType) return null;
  const bytes = await readFile(abs);
  return { node, resolvedSrc: src, bytes, mimeType };
}

/**
 * Build a complete SVG document from a cluster of sketch nodes,
 * optionally composited over backdrop image nodes the user drew on
 * top of.
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
 * same pixels the user saw when drawing them.
 *
 * Returns `null` when the cluster contributes no painted area (no
 * strokes anywhere, or every node has zero size) so callers can drop
 * it without surfacing a misleading 1×1 PNG.
 */
export function clusterToSvg(
  nodes: CanvasNode[],
  contextImages: ContextImage[] = [],
): { svg: string; width: number; height: number } | null {
  // World bbox = union of every contributing sketch + backdrop rect.
  // Including backdrops keeps the surrounding image context visible
  // even when the user circled only a small region.
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
    const { width: w, height: h } = nodeBoxSize(ci.node);
    if (w <= 0 || h <= 0) continue;
    const px = ci.node.position?.x ?? 0;
    const py = ci.node.position?.y ?? 0;
    x1 = Math.min(x1, px);
    y1 = Math.min(y1, py);
    x2 = Math.max(x2, px + w);
    y2 = Math.max(y2, py + h);
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

  const backdrops: string[] = [];
  for (const ci of contextImages) {
    const { width: w, height: h } = nodeBoxSize(ci.node);
    if (w <= 0 || h <= 0) continue;
    const ix = ci.node.position?.x ?? 0;
    const iy = ci.node.position?.y ?? 0;
    const href = `data:${ci.mimeType};base64,${ci.bytes.toString('base64')}`;
    backdrops.push(
      `<image x="${ix}" y="${iy}" width="${w}" height="${h}" ` +
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
  if (!anyStrokes) return null;

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
 * Bucket sketch nodes by their `parentId` and run single-linkage
 * spatial clustering inside each bucket. Two sketches that overlap in
 * flow space but live in different frames stay in separate clusters —
 * the user's mental model is that a frame is an explicit container, so
 * an "accidental overlap" across frames should not collapse two
 * separate gestures into one picture.
 */
function clusterSketchesByFrame(nodes: CanvasNode[]): CanvasNode[][] {
  const buckets = new Map<string, CanvasNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? '__root__';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(n);
    else buckets.set(key, [n]);
  }

  // findClusters wants `SpatialNode` ({ id, rect }). Build thin shims
  // that wrap each CanvasNode so we can recover the original after.
  type Shim = SpatialNode & { node: CanvasNode };
  const out: CanvasNode[][] = [];
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
 * The tool-facing {@link handleSnapshotNodes} wraps this in
 * `JSON.stringify`.
 */
export async function snapshotNodesToArtifacts(
  args: SnapshotNodesArgs,
): Promise<SnapshotNodeResult[]> {
  const ids = args.nodeIds ?? [];
  if (ids.length === 0) return [];

  const store = getCanvasStore(args.canvasId);
  const canvas = store.read();
  if (!canvas) {
    throw new Error(`Canvas ${args.canvasId} not found`);
  }
  const allNodes = (canvas.state.nodes ?? []) as CanvasNode[];
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
      throw new Error(`Node ${id} not found on canvas ${args.canvasId}.`);
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
  const sketchNodes: CanvasNode[] = [];

  for (const { id, fromFrame } of expansion) {
    // expansion only ever holds ids resolved via `byId`, so we can
    // safely re-read without an existence guard.
    const node = byId.get(id)!;
    const type = getNodeType(node);

    if (type === 'image') {
      const src = readSidecarString(store, id, 'src');
      if (!src) {
        if (fromFrame) continue;
        throw new Error(
          `Node ${id} (image) has no src — nothing to return. The artifact may have been deleted, or the node's markdown sidecar (nodes/<label>.md) is missing its \`src:\` frontmatter entry.`,
        );
      }
      results.push({ src, width: 0, height: 0, originNodeIds: [id] });
      continue;
    }
    if (type === 'sketch') {
      sketchNodes.push(node);
      continue;
    }
    // Non-snapshottable types coming via frame expansion are skipped
    // silently — the caller asked for the frame, not these children.
    if (fromFrame) continue;
    if (type === 'note' || type === 'text' || type === 'pdf') {
      throw new Error(
        `Node ${id} is a ${type} node — it has no still image to convert. Use \`read("nodes/<file>.md")\` to fetch the sidecar (text, frontmatter, etc.) and weave that into your prompt instead.`,
      );
    }
    if (type === 'video') {
      throw new Error(
        `Video node ${id} cannot be converted to a still image by this tool. If you need a frame, capture it on the canvas first; otherwise weave the node's sidecar content into your prompt via \`read("nodes/<file>.md")\`.`,
      );
    }
    throw new Error(
      `Node type "${type ?? 'unknown'}" cannot be converted to an image. Supported: image, sketch, frame (expands to its children).`,
    );
  }

  // ── Sketches: cluster, render, content-address ────────────────────────
  if (sketchNodes.length > 0) {
    const clusters = clusterSketchesByFrame(sketchNodes);
    for (const cluster of clusters) {
      // Sibling image nodes the sketch overlaps act as visual
      // backdrops so the AI sees the same composition the user did.
      const backdropNodes = findContextImageNodes(cluster, allNodes);
      const contextImages: ContextImage[] = [];
      for (const bn of backdropNodes) {
        const loaded = await loadContextImage(store, bn);
        if (loaded) contextImages.push(loaded);
      }
      const built = clusterToSvg(cluster, contextImages);
      const originNodeIds = cluster.map((n) => n.id);
      if (!built) {
        // Empty cluster (no strokes / zero area). Skip silently —
        // emitting a 1×1 placeholder would just confuse the model.
        continue;
      }
      const fingerprint = clusterFingerprint(cluster, contextImages);
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
export async function handleSnapshotNodes(
  args: SnapshotNodesArgs,
): Promise<string> {
  const results = await snapshotNodesToArtifacts(args);
  return JSON.stringify(results);
}
