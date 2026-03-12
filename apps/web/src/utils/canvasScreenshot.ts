/**
 * Capture the React Flow canvas viewport as a base64-encoded PNG string.
 *
 * Uses html-to-image to rasterise the `.react-flow__viewport` DOM node,
 * then draws node-label badges on top via Canvas 2D (no DOM mutation).
 */

import { toPng } from 'html-to-image';

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
  label: string;
  /** Position relative to the viewport element, already scaled by CAPTURE_RATIO. */
  x: number;
  y: number;
}

/**
 * Collect labels + positions for every visible node.
 * Positions are expressed in *image* pixels (viewport-relative × CAPTURE_RATIO).
 */
function collectNodeLabels(viewport: HTMLElement): NodeLabel[] {
  // toPng preserves the viewport's CSS transform, so the image coordinate
  // for a node is (panX + nodeScreenOffsetX) * CAPTURE_RATIO.
  // getBoundingClientRect subtraction gives nodeScreenOffsetX only — we need
  // to add back the pan offset that toPng bakes into the image.
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

    const r = el.getBoundingClientRect();
    result.push({
      label: nodeId,
      x: (panX + (r.left - vpRect.left)) * CAPTURE_RATIO,
      y: (panY + (r.top - vpRect.top)) * CAPTURE_RATIO,
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

/** Draw label badges onto a canvas and return the final data-URL. */
function drawLabels(img: HTMLImageElement, labels: NodeLabel[]): string {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;

  ctx.drawImage(img, 0, 0);

  const fontSize = 10 * CAPTURE_RATIO;
  const paddingX = 6 * CAPTURE_RATIO;
  const paddingY = 4 * CAPTURE_RATIO;
  const radius = 4 * CAPTURE_RATIO;
  const offsetY = 4 * CAPTURE_RATIO; // gap above node top edge

  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'top';

  for (const { label, x, y } of labels) {
    const text = label.length > 30 ? label.slice(0, 29) + '…' : label;
    const tw = ctx.measureText(text).width;
    const bw = tw + paddingX * 2;
    const bh = fontSize + paddingY * 2;
    const bx = x;
    const by = y - bh - offsetY;

    // Rounded rect background
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, radius);
    ctx.fillStyle = '#000';
    ctx.fill();

    // Text
    ctx.fillStyle = '#fff';
    ctx.fillText(text, bx + paddingX, by + paddingY);
  }

  return canvas.toDataURL('image/png');
}

/**
 * Capture the current React Flow viewport and return a base64 data-URL PNG.
 *
 * After the raw capture, node-label badges are painted on top using Canvas 2D
 * so the AI can identify nodes visually. No temporary DOM elements are injected,
 * which avoids any visible flash on screen.
 *
 * Pass `stripPrefix: true` to get the raw base64 payload only.
 */
export async function captureCanvasScreenshot(options?: {
  /** Return raw base64 without the `data:image/png;base64,` prefix. */
  stripPrefix?: boolean;
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

    // Draw labels onto the captured image
    const img = await loadImage(rawDataUrl);
    const dataUrl = drawLabels(img, labels);

    if (options?.stripPrefix) {
      return dataUrl.replace(/^data:image\/png;base64,/, '');
    }

    return dataUrl;
  } catch (err) {
    console.error('[screenshot] Failed to capture canvas:', err);
    return undefined;
  }
}
