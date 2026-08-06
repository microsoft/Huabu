// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const SEDIMENT_NODES_KEY = '__sediment_nodes__';
const SEDIMENT_EDGES_KEY = '__sediment_edges__';
const SEDIMENT_CANVAS_ID_KEY = '__sediment_canvas_id__';

/**
 * Attribute carrying the serialized node payload inside the `text/html`
 * clipboard representation.
 *
 * The payload used to live in `text/plain`, which meant pasting a node into
 * any external plain-text target dumped raw JSON at the user. `text/html` is
 * invisible to plain-text targets, so `text/plain` is free to hold a readable
 * label instead. `text/html` is preferred over a `web ` custom format because
 * custom formats are Chromium-only on the read side, and Huabu serves plain
 * browsers as well as Electron.
 */
const SEDIMENT_HTML_ATTR = 'data-sediment-nodes';

export interface SedimentClipboard {
  nodes: unknown[];
  edges: unknown[];
  /** The canvas the nodes were copied from. May be undefined for legacy payloads. */
  srcCanvasId?: string;
}

export interface SedimentClipboardImage {
  src: string;
  label?: string;
}

/** Parse serialized Sediment canvas nodes from system clipboard text. */
export function parseSedimentClipboard(
  text: string | null | undefined,
): SedimentClipboard | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;

    const record = parsed as Record<string, unknown>;
    const nodes = record[SEDIMENT_NODES_KEY];
    if (!Array.isArray(nodes) || nodes.length === 0) return null;

    const rawEdges = record[SEDIMENT_EDGES_KEY];
    const rawCanvasId = record[SEDIMENT_CANVAS_ID_KEY];
    const edges = Array.isArray(rawEdges) ? rawEdges : [];
    const srcCanvasId =
      typeof rawCanvasId === 'string' ? rawCanvasId : undefined;

    return {
      nodes,
      edges,
      ...(srcCanvasId ? { srcCanvasId } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Parse an internal clipboard payload only when every copied node is an image.
 * This prevents note editors from consuming mixed canvas selections as images.
 */
export function parseSedimentImageClipboard(
  text: string | null | undefined,
): { images: SedimentClipboardImage[]; srcCanvasId?: string } | null {
  const clipboard = parseSedimentClipboard(text);
  if (!clipboard) return null;

  const images: SedimentClipboardImage[] = [];
  for (const node of clipboard.nodes) {
    if (!node || typeof node !== 'object') return null;
    const nodeRecord = node as Record<string, unknown>;
    if (nodeRecord.type !== 'image') return null;

    const data = nodeRecord.data;
    if (!data || typeof data !== 'object') return null;
    const imageData = data as Record<string, unknown>;
    const src = imageData.src;
    if (typeof src !== 'string' || src.trim() === '') return null;
    const label = imageData.label;
    images.push({
      src: src.trim(),
      ...(typeof label === 'string' && label.trim()
        ? { label: label.trim() }
        : {}),
    });
  }

  return {
    images,
    ...(clipboard.srcCanvasId ? { srcCanvasId: clipboard.srcCanvasId } : {}),
  };
}

/** Base64-encode UTF-8 text (`btoa` alone throws on non-Latin1 characters). */
function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Inverse of {@link encodeBase64Utf8}. */
function decodeBase64Utf8(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Extract the serialized node payload from a `text/html` clipboard
 * representation. Returns `null` when the HTML carries no Huabu payload.
 */
export function parseSedimentClipboardHtml(
  html: string | null | undefined,
): string | null {
  if (!html) return null;
  try {
    // `DOMParser` does not execute scripts or load subresources, and the
    // parsed document is never attached to the live DOM — only one attribute
    // is read back out of it.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const encoded = doc
      .querySelector(`[${SEDIMENT_HTML_ATTR}]`)
      ?.getAttribute(SEDIMENT_HTML_ATTR);
    if (!encoded) return null;
    return decodeBase64Utf8(encoded);
  } catch {
    return null;
  }
}

/**
 * Read Huabu's serialized payload out of a paste event, preferring the
 * `text/html` representation and falling back to `text/plain`.
 *
 * The fallback keeps clipboard contents produced by older builds working, and
 * covers copies that never went through the HTML path (multi-node selections
 * still serialize into `text/plain`).
 */
export function readSedimentClipboardPayload(
  data: DataTransfer | null | undefined,
): string | null {
  if (!data) return null;
  const fromHtml = parseSedimentClipboardHtml(data.getData('text/html'));
  if (fromHtml) return fromHtml;
  return data.getData('text/plain') || null;
}

/**
 * Async counterpart to {@link readSedimentClipboardPayload}, for the fallback
 * path where no native `paste` event fires and only the Clipboard API is
 * available. Reads `text/html` first so single-image copies are still restored
 * as nodes rather than re-imported as a fresh image.
 */
export async function readSedimentClipboardPayloadAsync(): Promise<
  string | null
> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (!item.types.includes('text/html')) continue;
      const html = await (await item.getType('text/html')).text();
      const payload = parseSedimentClipboardHtml(html);
      if (payload) return payload;
    }
  } catch {
    // `clipboard.read()` unavailable or denied — fall through to text.
  }

  try {
    return (await navigator.clipboard.readText()) || null;
  } catch {
    return null;
  }
}

export const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fallback for environments where Clipboard API is unavailable.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.left = '-1000px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
};

async function fetchImageAsPng(src: string): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) throw new Error('Failed to fetch clipboard image');

  const source = await response.blob();
  if (source.type === 'image/png') return source;

  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.drawImage(bitmap, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to encode clipboard image'));
      }, 'image/png');
    });
  } finally {
    bitmap.close();
  }
}

/** Escape text for interpolation into HTML text content or an attribute. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escape text for HTML text content, keeping its line structure.
 *
 * Rich-text targets prefer `text/html` over `text/plain`, and HTML collapses
 * raw newlines into spaces — without this a multi-line note would paste into
 * Word or Slack as a single run-on line. The newline is replaced rather than
 * kept next to the `<br>` so targets honouring `white-space: pre-wrap` do not
 * render the break twice.
 */
function escapeHtmlMultiline(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read clipboard image'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Build the `text/html` representation for a single image node: an image the
 * receiving application can render, carrying the serialized node payload in a
 * data attribute.
 *
 * The image is inlined as a `data:` URL rather than linked by artifact URL
 * because rich-text targets often prefer `text/html` over `image/png`, and the
 * artifact URL points at a local API origin they cannot reach.
 */
function buildImageClipboardHtml(
  payload: string,
  dataUrl: string,
  label: string,
): string {
  return (
    `<img src="${escapeHtml(dataUrl)}"` +
    ` alt="${escapeHtml(label)}"` +
    ` ${SEDIMENT_HTML_ATTR}="${encodeBase64Utf8(payload)}">`
  );
}

/**
 * Build the `text/html` representation for a non-image selection: the same
 * text a plain-text target receives, wrapped in an element carrying the
 * payload. Rich-text targets that prefer `text/html` therefore paste the same
 * thing as plain-text targets rather than an empty element.
 */
function buildTextClipboardHtml(payload: string, plainText: string): string {
  return (
    `<span ${SEDIMENT_HTML_ATTR}="${encodeBase64Utf8(payload)}">` +
    `${escapeHtmlMultiline(plainText)}</span>`
  );
}

/**
 * Copy options for {@link copyCanvasClipboard}.
 */
export interface CanvasClipboardCopy {
  /** Serialized nodes/edges, always carried in `text/html`. */
  payload: string;
  /** Human-readable text for foreign applications; omitted when empty. */
  plainText?: string;
  /** Set for a single-image selection, which pastes as a real image. */
  image?: { src: string; label?: string | undefined } | undefined;
}

/**
 * Write a copied canvas selection to the system clipboard.
 *
 * Two audiences are served by one write:
 *
 * - **Huabu** reads the serialized payload from `text/html`, so pasting back
 *   preserves node identity and artifact ownership.
 * - **Other applications** get `image/png` for a single image, or `text/plain`
 *   for anything with a textual form. The serialized payload never reaches
 *   `text/plain`, so external pastes no longer dump JSON at the user.
 *
 * Everything goes into a single `ClipboardItem`: one copy gesture only
 * authorizes one clipboard write, so an extra preparatory `writeText` would
 * make the real write fail with `NotAllowedError` and drop the image.
 *
 * If the write fails the payload is written to `text/plain` as a last resort —
 * external pastes degrade to JSON, but Huabu-to-Huabu paste keeps working.
 */
export async function copyCanvasClipboard({
  payload,
  plainText = '',
  image,
}: CanvasClipboardCopy): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    await copyToClipboard(payload);
    return;
  }

  if (!image) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([buildTextClipboardHtml(payload, plainText)], {
            type: 'text/html',
          }),
          ...(plainText
            ? { 'text/plain': new Blob([plainText], { type: 'text/plain' }) }
            : {}),
        }),
      ]);
    } catch (err) {
      console.warn('[clipboard] copy failed, writing node payload', err);
      await copyToClipboard(payload);
    }
    return;
  }

  const png = fetchImageAsPng(image.src);
  const html = png
    .then(blobToDataUrl)
    .then(
      (dataUrl) =>
        new Blob(
          [
            buildImageClipboardHtml(
              payload,
              dataUrl,
              image.label?.trim() ?? '',
            ),
          ],
          { type: 'text/html' },
        ),
    );

  try {
    // No `text/plain`: an image should paste as an image and nothing else.
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/html': html, 'image/png': png }),
    ]);
  } catch (err) {
    // Both promises are already settled or abandoned here; swallow their
    // rejections so they do not surface as unhandled promise errors.
    void png.catch(() => undefined);
    void html.catch(() => undefined);
    console.warn('[clipboard] image copy failed, writing node payload', err);
    await copyToClipboard(payload);
  }
}
