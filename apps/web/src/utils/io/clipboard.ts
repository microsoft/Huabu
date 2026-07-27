const SEDIMENT_NODES_KEY = '__sediment_nodes__';
const SEDIMENT_EDGES_KEY = '__sediment_edges__';
const SEDIMENT_CANVAS_ID_KEY = '__sediment_canvas_id__';

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

/** Write one image for external apps while retaining Huabu's node payload. */
export async function copyImageToClipboard(
  text: string,
  imageSrc: string,
): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    await copyToClipboard(text);
    return;
  }

  try {
    const item = new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' }),
      'image/png': fetchImageAsPng(imageSrc),
    });
    await navigator.clipboard.write([item]);
  } catch {
    await copyToClipboard(text);
  }
}
