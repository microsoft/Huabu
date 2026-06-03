/**
 * Sketch → Image (PNG dataURL)
 *
 * Renders a group of sketch nodes (typically one spatial cluster from
 * `clusterSketches`) into a single PNG so it can ride the chat-message
 * vision pipeline as an `image` attachment.
 *
 * Why client-side, on-demand:
 *  - We deliberately do not auto-flatten clusters into image nodes
 *    (that's Phase 2 of the sketch design); the image only exists for
 *    the chat send and is otherwise ephemeral.
 *  - Doing it from the React Flow node list rather than from a screen
 *    capture gives a clean image (no neighbouring nodes, no zoom
 *    artefacts, no hidden DOM stacking) and works whether or not the
 *    cluster is currently in the viewport.
 *
 * Implementation: replicate the same `perfect-freehand` → SVG path
 * pipeline that the on-canvas `SketchNode` uses (`pointsToPath`), but
 * draw every stroke in *world* coordinates so a single SVG can carry
 * an arbitrary number of sketch nodes whose own bboxes may differ.
 * Then rasterise via `<img>` + `<canvas>` so callers receive a PNG
 * dataURL that resolves directly through the existing image-attachment
 * branch in `agent.route.ts:buildUserContent`.
 */

import { resolveAccent } from '@sediment/shared';

import {
  pointsToPath,
  DEFAULT_STROKE_COLOR,
  DEFAULT_STROKE_SIZE,
} from '@/components/Nodes/sketch/sketchPath';

import type { SketchStroke } from '@sediment/shared';
import type { Node } from '@xyflow/react';

/** A sketch node as carried in the React Flow node list. */
type SketchFlowNode = Node & {
  data: {
    strokes?: SketchStroke[];
    initialSize?: { width: number; height: number };
  };
};

export interface RenderSketchClusterOptions {
  /** Padding around the cluster bbox (flow-space units). Default: 16. */
  padding?: number;
  /** Maximum width / height in PNG pixels; the cluster is scaled to fit. Default: 2048. */
  maxPixels?: number;
  /** Background fill colour. Default: white (so dark strokes stay legible). */
  background?: string;
}

const DEFAULT_PADDING = 16;
const DEFAULT_MAX_PIXELS = 2048;
const DEFAULT_BACKGROUND = '#ffffff';

/**
 * Effective on-canvas size for a sketch node. Prefers React Flow's
 * measured `width` / `height` (which reflect any user resize), then
 * `data.initialSize`, then 0 (defensive — should not happen for a
 * stroked sketch).
 */
function effectiveSize(node: SketchFlowNode): {
  width: number;
  height: number;
} {
  const w = node.width ?? node.data.initialSize?.width ?? 0;
  const h = node.height ?? node.data.initialSize?.height ?? 0;
  return { width: w, height: h };
}

/**
 * Compute the union bbox (in flow-space) of every node in the cluster.
 * Returns `null` when the cluster contributes no painted area
 * (no strokes at all, or every node has zero size).
 */
function clusterWorldBbox(nodes: SketchFlowNode[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const n of nodes) {
    const { width, height } = effectiveSize(n);
    if (width <= 0 || height <= 0) continue;
    x1 = Math.min(x1, n.position.x);
    y1 = Math.min(y1, n.position.y);
    x2 = Math.max(x2, n.position.x + width);
    y2 = Math.max(y2, n.position.y + height);
  }
  if (!isFinite(x1) || !isFinite(y1)) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Build the inner `<path>` markup for one sketch node, with every
 * stroke transformed into world coordinates (so the parent SVG can
 * just declare `viewBox = clusterBbox`).
 */
function nodeStrokesToWorldPaths(node: SketchFlowNode): string {
  const data = node.data;
  const strokes = data.strokes ?? [];
  if (strokes.length === 0) return '';
  const init = data.initialSize ?? { width: 1, height: 1 };
  const { width, height } = effectiveSize(node);
  // Match the on-canvas renderer: scale points by (current size / initial size)
  // but keep stroke thickness untouched.
  const scaleX = init.width > 0 ? width / init.width : 1;
  const scaleY = init.height > 0 ? height / init.height : 1;
  const ox = node.position.x;
  const oy = node.position.y;

  const paths: string[] = [];
  for (const stroke of strokes) {
    const worldPoints = stroke.points.map((pt) => [
      pt[0] * scaleX + ox,
      pt[1] * scaleY + oy,
      pt[2] ?? 0.5,
    ]);
    const d = pointsToPath(worldPoints, 1, stroke.size ?? DEFAULT_STROKE_SIZE);
    if (!d) continue;
    const colorToken = stroke.color ?? DEFAULT_STROKE_COLOR;
    const fill = resolveAccent(colorToken) ?? colorToken;
    paths.push(`<path d="${d}" fill="${escapeAttr(fill)}" />`);
  }
  return paths.join('');
}

/** Minimal XML attribute escaping for the stroke fill colour. */
function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * Render a group of sketch nodes into a single PNG dataURL.
 *
 * Returns `null` when the input has no usable geometry (caller should
 * skip producing an attachment). Throws when the browser fails to
 * decode the generated SVG (extremely defensive — would indicate a
 * malformed `pointsToPath` output).
 */
export async function renderSketchClusterToPng(
  nodes: SketchFlowNode[],
  options: RenderSketchClusterOptions = {},
): Promise<string | null> {
  if (nodes.length === 0) return null;
  const padding = options.padding ?? DEFAULT_PADDING;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const background = options.background ?? DEFAULT_BACKGROUND;

  const bbox = clusterWorldBbox(nodes);
  if (!bbox || bbox.width <= 0 || bbox.height <= 0) return null;

  const vbX = bbox.x - padding;
  const vbY = bbox.y - padding;
  const vbW = bbox.width + padding * 2;
  const vbH = bbox.height + padding * 2;

  // Fit-to-`maxPixels` scaling so very large clusters do not produce
  // multi-megabyte PNGs.
  const scale = Math.min(1, maxPixels / Math.max(vbW, vbH));
  const pxW = Math.max(1, Math.round(vbW * scale));
  const pxH = Math.max(1, Math.round(vbH * scale));

  const innerPaths = nodes.map(nodeStrokesToWorldPaths).join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${pxW}" height="${pxH}">` +
    `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${escapeAttr(background)}" />` +
    innerPaths +
    `</svg>`;

  return await rasterizeSvg(svg, pxW, pxH);
}

/**
 * Decode an inline SVG string into a PNG dataURL via `<img>` +
 * `<canvas>`. Uses a Blob URL (rather than data: URI) to side-step
 * size limits in some browsers; revokes the URL once decoding has
 * settled either way.
 */
function rasterizeSvg(
  svgString: string,
  width: number,
  height: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error('Canvas 2D context unavailable'));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode sketch SVG'));
    };
    img.src = url;
  });
}
