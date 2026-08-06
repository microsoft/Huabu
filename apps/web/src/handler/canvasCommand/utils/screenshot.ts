// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Capture the React Flow canvas viewport as a base64-encoded PNG string.
 *
 * Uses html-to-image to rasterise the `.react-flow__viewport` DOM node,
 * then draws node-label badges on top via Canvas 2D (no DOM mutation).
 * Optionally annotates the last user action with colored visual markers.
 */

import { toPng } from 'html-to-image';

import type { RecentAction } from '@huabu/shared';

/** Pixel ratio used for the capture — 3× keeps text legible on all displays. */
const CAPTURE_RATIO = 3;

/**
 * Ensure a screenshot string is a full `data:image/png;base64,…` URL.
 * Accepts both raw base64 payloads and existing data-URLs.
 */
export function toScreenshotDataUrl(screenshot: string): string {
  return screenshot.startsWith('data:')
    ? screenshot
    : `data:image/png;base64,${screenshot}`;
}

/** Label info resolved for a single node. */
interface NodeLabel {
  id: string;
  label: string;
  /** Node type (e.g. 'note', 'sketch'). */
  nodeType: string;
  /** Position relative to the viewport element, already scaled by CAPTURE_RATIO. */
  x: number;
  y: number;
  /** Width/height in image pixels (scaled by CAPTURE_RATIO). */
  w: number;
  h: number;
}

/**
 * Collect labels + positions for every visible node.
 * Positions are expressed in *image* pixels (viewport-relative × CAPTURE_RATIO).
 */
function collectNodeLabels(viewport: HTMLElement): NodeLabel[] {
  const match = viewport.style.transform.match(
    /translate\(([^,]+)px,\s*([^)]+)px\)/,
  );
  const panX = match ? parseFloat(match[1]) : 0;
  const panY = match ? parseFloat(match[2]) : 0;

  const vpRect = viewport.getBoundingClientRect();
  const result: NodeLabel[] = [];
  const nodeElements =
    viewport.querySelectorAll<HTMLElement>('.react-flow__node');

  for (const el of nodeElements) {
    const nodeId = el.getAttribute('data-id');
    if (!nodeId) continue;

    // React Flow stores the node type as a class: react-flow__node-<type>
    const typeClass = Array.from(el.classList).find((c) =>
      c.startsWith('react-flow__node-'),
    );
    const nodeType = typeClass?.replace('react-flow__node-', '') ?? 'unknown';

    const r = el.getBoundingClientRect();
    result.push({
      id: nodeId,
      label: nodeId,
      nodeType,
      x: (panX + (r.left - vpRect.left)) * CAPTURE_RATIO,
      y: (panY + (r.top - vpRect.top)) * CAPTURE_RATIO,
      w: r.width * CAPTURE_RATIO,
      h: r.height * CAPTURE_RATIO,
    });
  }

  return result;
}

/** Load a data-URL into an HTMLImageElement. */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// ---------------------------------------------------------------------------
// Annotation for last-action highlights — all in red for clear visual signal
// ---------------------------------------------------------------------------

const ANNOTATION_COLOR = '#ef4444';

/** Describe a RecentAction as a human-readable "Last step" label. */
function describeAction(action: RecentAction): string {
  switch (action.action) {
    case 'node_created': {
      const names = action.nodes.map((n) => n.label ?? n.id).join(', ');
      return `Last step: Created ${action.nodes.length} node(s) — ${names}`;
    }
    case 'nodes_deleted': {
      const names = action.nodes.map((n) => n.label ?? n.id).join(', ');
      return `Last step: Deleted ${action.nodes.length} node(s) — ${names}`;
    }
    case 'node_edited':
      return `Last step: Edited "${action.node.label ?? action.node.id}"`;
    case 'node_selected':
      return `Last step: Selected "${action.node.label ?? action.node.id}"`;
    case 'nodes_selected':
      return `Last step: Selected ${action.nodes.length} nodes`;
    case 'node_expanded':
      return `Last step: Expanded "${action.node.label ?? action.node.id}"`;
    case 'node_connected':
      return `Last step: Connected "${action.source.label ?? action.source.id}" → "${action.target.label ?? action.target.id}"`;
    case 'edges_disconnected':
      return `Last step: Disconnected ${action.edges.length} edge(s)`;
    case 'node_framed':
      return `Last step: Moved "${action.node.label ?? action.node.id}" into frame "${action.frame.label ?? action.frame.id}"`;
    case 'node_unframed':
      return `Last step: Removed "${action.node.label ?? action.node.id}" from frame`;
    case 'frame_unframed':
      return `Last step: Dissolved frame "${action.frame.label ?? action.frame.id}"`;
    case 'node_resized':
      return `Last step: Resized "${action.node.label ?? action.node.id}"`;
    case 'nodes_reordered':
      return `Last step: Reordered ${action.nodes.length} node(s)`;
    case 'nodes_moved': {
      const names = action.nodes.map((n) => n.label ?? n.id).join(', ');
      return `Last step: Moved ${action.nodes.length} node(s) — ${names}`;
    }
    case 'canvas_undone':
      return 'Last step: Undo';
    case 'canvas_redone':
      return 'Last step: Redo';
  }
}

/**
 * Extract the set of node IDs involved in a RecentAction.
 */
function getActionAnnotation(action: RecentAction): {
  nodeIds: Set<string>;
  badge: string;
  /** Pairs of [sourceId, targetId] to draw arrows between. */
  arrows: Array<[string, string]>;
} {
  switch (action.action) {
    case 'node_created':
      return {
        nodeIds: new Set(action.nodes.map((n) => n.id)),
        badge: describeAction(action),
        arrows: [],
      };
    case 'nodes_deleted':
      return {
        nodeIds: new Set(action.nodes.map((n) => n.id)),
        badge: describeAction(action),
        arrows: [],
      };
    case 'node_edited':
      return {
        nodeIds: new Set([action.node.id]),
        badge: describeAction(action),
        arrows: [],
      };
    case 'node_selected':
      return {
        nodeIds: new Set([action.node.id]),
        badge: describeAction(action),
        arrows: [],
      };
    case 'nodes_selected':
      return {
        nodeIds: new Set(action.nodes.map((n) => n.id)),
        badge: describeAction(action),
        arrows: [],
      };
    case 'node_expanded':
      return {
        nodeIds: new Set([action.node.id]),
        badge: describeAction(action),
        arrows: [],
      };
    case 'node_connected':
      return {
        nodeIds: new Set([action.source.id, action.target.id]),
        badge: describeAction(action),
        arrows: [[action.source.id, action.target.id]],
      };
    case 'edges_disconnected': {
      const ids = new Set<string>();
      const arrows: Array<[string, string]> = [];
      for (const e of action.edges) {
        ids.add(e.source.id);
        ids.add(e.target.id);
        arrows.push([e.source.id, e.target.id]);
      }
      return { nodeIds: ids, badge: describeAction(action), arrows };
    }
    case 'node_framed':
      return {
        nodeIds: new Set([action.node.id, action.frame.id]),
        badge: describeAction(action),
        arrows: [[action.node.id, action.frame.id]],
      };
    case 'node_unframed':
      return {
        nodeIds: new Set([action.node.id, action.frame.id]),
        badge: describeAction(action),
        arrows: [[action.frame.id, action.node.id]],
      };
    case 'frame_unframed':
      return {
        nodeIds: new Set([action.frame.id, ...action.nodes.map((n) => n.id)]),
        badge: describeAction(action),
        arrows: [],
      };
    case 'node_resized':
      return {
        nodeIds: new Set([action.node.id]),
        badge: describeAction(action),
        arrows: [],
      };
    case 'nodes_reordered':
      return {
        nodeIds: new Set(action.nodes.map((n) => n.id)),
        badge: describeAction(action),
        arrows: [],
      };
    case 'nodes_moved':
      return {
        nodeIds: new Set(action.nodes.map((n) => n.id)),
        badge: describeAction(action),
        arrows: [],
      };
    case 'canvas_undone':
      return { nodeIds: new Set(), badge: describeAction(action), arrows: [] };
    case 'canvas_redone':
      return { nodeIds: new Set(), badge: describeAction(action), arrows: [] };
  }
}

// ---------------------------------------------------------------------------
// Canvas 2D drawing
// ---------------------------------------------------------------------------

/** Draw label badges and action annotations onto a canvas and return the final data-URL. */
function drawAnnotatedImage(
  img: HTMLImageElement,
  labels: NodeLabel[],
  lastAction?: RecentAction,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;

  ctx.drawImage(img, 0, 0);

  // Build a lookup from id → NodeLabel for action annotations
  const labelMap = new Map(labels.map((l) => [l.id, l]));

  // Resolve action annotation info
  const annotation = lastAction ? getActionAnnotation(lastAction) : null;
  const highlightIds = annotation?.nodeIds ?? new Set<string>();

  const fontSize = 14 * CAPTURE_RATIO;
  const paddingX = 8 * CAPTURE_RATIO;
  const paddingY = 5 * CAPTURE_RATIO;
  const radius = 4 * CAPTURE_RATIO;
  const offsetY = 4 * CAPTURE_RATIO; // gap above node top edge
  const borderWidth = 3 * CAPTURE_RATIO;

  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'top';

  // --- Pass 1: Draw red highlight borders on nodes involved in the last action ---
  if (annotation) {
    for (const nodeId of highlightIds) {
      const nl = labelMap.get(nodeId);
      if (!nl) continue;

      ctx.strokeStyle = ANNOTATION_COLOR;
      ctx.lineWidth = borderWidth;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.roundRect(
        nl.x - borderWidth,
        nl.y - borderWidth,
        nl.w + borderWidth * 2,
        nl.h + borderWidth * 2,
        radius,
      );
      ctx.stroke();
    }
  }

  // --- Pass 2: Draw ID badges on all non-sketch nodes ---
  // Sketch nodes don't get badges — they are drawn in Pass 5.
  for (const nl of labels) {
    if (nl.nodeType === 'sketch') continue;

    const isHighlighted = highlightIds.has(nl.id);
    const text = nl.label;
    const tw = ctx.measureText(text).width;
    const bw = tw + paddingX * 2;
    const bh = fontSize + paddingY * 2;
    const bx = nl.x;
    const by = nl.y - bh - offsetY;

    // Transparent background with border + black text for normal badges,
    // red badge for highlighted nodes.
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, radius);
    if (isHighlighted) {
      ctx.fillStyle = ANNOTATION_COLOR;
      ctx.fill();
      ctx.fillStyle = '#fff';
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5 * CAPTURE_RATIO;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.fillStyle = '#000';
    }

    ctx.fillText(text, bx + paddingX, by + paddingY);
  }

  // --- Pass 3: Draw descriptive "Last step" banner at top of image ---
  if (annotation && annotation.badge) {
    const bannerFontSize = 20 * CAPTURE_RATIO;
    ctx.font = `700 ${bannerFontSize}px system-ui, -apple-system, sans-serif`;

    const bannerText = annotation.badge;
    const btw = ctx.measureText(bannerText).width;
    const bPadX = 18 * CAPTURE_RATIO;
    const bPadY = 14 * CAPTURE_RATIO;
    const bw = btw + bPadX * 2;
    const bh = bannerFontSize + bPadY * 2;
    const bx = 12 * CAPTURE_RATIO;
    const by = 12 * CAPTURE_RATIO;

    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, radius);
    ctx.fillStyle = ANNOTATION_COLOR;
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.fillText(bannerText, bx + bPadX, by + bPadY);
  }

  // --- Pass 4: Draw arrows between related node pairs ---
  if (annotation) {
    for (const [fromId, toId] of annotation.arrows) {
      const srcNl = labelMap.get(fromId);
      const tgtNl = labelMap.get(toId);
      if (!srcNl || !tgtNl) continue;
      drawArrow(
        ctx,
        srcNl.x + srcNl.w / 2,
        srcNl.y + srcNl.h / 2,
        tgtNl.x + tgtNl.w / 2,
        tgtNl.y + tgtNl.h / 2,
        ANNOTATION_COLOR,
        borderWidth,
      );
    }
  }

  // --- Pass 5: Draw a single red bounding box around all sketch nodes ---
  // Sketch strokes are ephemeral gestures; grouping them into one box
  // keeps the visual layer clean and avoids cluttering with individual IDs.
  const sketchNodes = labels.filter((nl) => nl.nodeType === 'sketch');
  if (sketchNodes.length > 0) {
    const sketchBorder = 3 * CAPTURE_RATIO;
    const pad = 6 * CAPTURE_RATIO;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const nl of sketchNodes) {
      minX = Math.min(minX, nl.x);
      minY = Math.min(minY, nl.y);
      maxX = Math.max(maxX, nl.x + nl.w);
      maxY = Math.max(maxY, nl.y + nl.h);
    }

    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = sketchBorder;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.roundRect(
      minX - pad,
      minY - pad,
      maxX - minX + pad * 2,
      maxY - minY + pad * 2,
      radius,
    );
    ctx.stroke();
  }

  return canvas.toDataURL('image/png');
}

/** Draw a directional arrow between two points. */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string,
  lineWidth: number,
): void {
  const headLen = 15 * CAPTURE_RATIO;
  const angle = Math.atan2(toY - fromY, toX - fromX);

  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([8 * CAPTURE_RATIO, 6 * CAPTURE_RATIO]);

  // Line
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  // Arrowhead
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - headLen * Math.cos(angle - Math.PI / 6),
    toY - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    toX - headLen * Math.cos(angle + Math.PI / 6),
    toY - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

/**
 * Capture the current React Flow viewport and return a base64 data-URL PNG.
 *
 * After the raw capture, node-label badges are painted on top using Canvas 2D
 * so the AI can identify nodes visually. When `lastAction` is provided, the
 * nodes involved in that action are highlighted with a colored border and
 * action-type badge (e.g. "✦ NEW", "↗ MOVE", "✎ EDIT").
 *
 * No temporary DOM elements are injected, which avoids any visible flash on screen.
 *
 * Pass `stripPrefix: true` to get the raw base64 payload only.
 */
export async function captureCanvasScreenshot(options?: {
  /** Return raw base64 without the `data:image/png;base64,` prefix. */
  stripPrefix?: boolean;
  /** The most recent user action — highlighted with colored annotations. */
  lastAction?: RecentAction;
}): Promise<string | undefined> {
  const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport) {
    console.warn('[screenshot] .react-flow__viewport not found');
    return undefined;
  }

  try {
    // Collect label info while DOM is stable (before async gap)
    const labels = collectNodeLabels(viewport);

    const rawDataUrl = await toPng(viewport, {
      pixelRatio: CAPTURE_RATIO,
      skipAutoScale: true,
      cacheBust: true,
      // Skip external images (e.g. favicons) that may fail to load cross-origin
      // on certain platforms (Windows), which would abort the entire capture.
      filter: (node: HTMLElement) => {
        if (node instanceof HTMLImageElement) {
          const src = node.src ?? '';
          // Keep inline data-URLs and relative images; skip external URLs
          if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
            return false;
          }
        }
        return true;
      },
    });

    // If there are no labels, return the raw capture directly
    if (labels.length === 0) {
      if (options?.stripPrefix) {
        return rawDataUrl.replace(/^data:image\/png;base64,/, '');
      }
      return rawDataUrl;
    }

    // Draw labels and action annotations onto the captured image
    const img = await loadImage(rawDataUrl);
    const dataUrl = drawAnnotatedImage(img, labels, options?.lastAction);

    if (options?.stripPrefix) {
      return dataUrl.replace(/^data:image\/png;base64,/, '');
    }

    return dataUrl;
  } catch (err) {
    console.error('[screenshot] Failed to capture canvas:', err);
    return undefined;
  }
}
