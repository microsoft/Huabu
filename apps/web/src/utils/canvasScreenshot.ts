/**
 * Capture the React Flow canvas viewport as a base64-encoded PNG string.
 *
 * Uses html-to-image to rasterise the `.react-flow__viewport` DOM node.
 * Returns `undefined` if the element is not found or the capture fails.
 */

import { toPng } from 'html-to-image';

/**
 * Capture the current React Flow viewport and return a base64 data-URL PNG.
 *
 * The returned string is a full data-URL (`data:image/png;base64,…`).
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
    const dataUrl = await toPng(viewport, {
      // Downsample to keep the payload small (≤ ~200 KB typically)
      pixelRatio: 1,
      // Skip capturing cross-origin images that would taint the canvas
      skipAutoScale: true,
      cacheBust: true,
    });

    if (options?.stripPrefix) {
      return dataUrl.replace(/^data:image\/png;base64,/, '');
    }

    return dataUrl;
  } catch (err) {
    console.error('[screenshot] Failed to capture canvas:', err);
    return undefined;
  }
}
