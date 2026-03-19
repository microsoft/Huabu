/**
 * Centralized node-creation defaults.
 *
 * This module owns canonical node sizing.
 * UI-only placement semantics and final node assembly live elsewhere so
 * persisted node positions remain unambiguous.
 */

// ---------------------------------------------------------------------------
// Default dimensions per node type
// ---------------------------------------------------------------------------
// TODO: this file name is outdated; consider renaming to nodeDefaults.ts or similar to avoid confusion with factory patterns.
export interface NodeSize {
  width: number;
  // Optional height: some node types (e.g. text/note) use content-driven height,
  // so a width-only default is valid.
  height?: number;
}

type MediaNodeType = 'image' | 'video';

const DEFAULT_SIZES: Record<string, NodeSize> = {
  text: { width: 200 },
  note: { width: 400 },
  web: { width: 300, height: 200 },
  pdf: { width: 400, height: 300 },
  video: { width: 400, height: 300 },
  image: { width: 300, height: 200 },
  frame: { width: 400, height: 300 },
};

/** Default image node size — safe to reference directly without null checks. */
export const IMAGE_DEFAULT_SIZE: NodeSize = DEFAULT_SIZES.image;

/**
 * Return the canonical default size hints for a node type.
 * Text and note nodes expose only a default width because their height is
 * content-driven at render time.
 */
export function getNodeDefaultSize(nodeType: string): NodeSize | null {
  return DEFAULT_SIZES[nodeType];
}

/**
 * Compute the display size for an image node, scaling to a fixed width
 * while preserving the original aspect ratio.
 *
 * If natural dimensions are unknown (0 or missing), returns the default.
 */
export function computeMediaSize(
  nodeType: MediaNodeType,
  naturalWidth: number,
  naturalHeight: number,
): NodeSize {
  const defaultSize = getNodeDefaultSize(nodeType) ?? IMAGE_DEFAULT_SIZE;
  const targetWidth = defaultSize.width;

  if (naturalWidth <= 0 || naturalHeight <= 0) return defaultSize;

  return {
    width: targetWidth,
    height: Math.round(targetWidth * (naturalHeight / naturalWidth)),
  };
}
