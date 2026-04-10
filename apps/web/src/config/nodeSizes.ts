import type { NodeSize } from '@sediment/shared';

// ---------------------------------------------------------------------------
// Default dimensions per node type
// ---------------------------------------------------------------------------
const DEFAULT_SIZES: Record<string, NodeSize> = {
  text: { width: 200 },
  note: { width: 400 },
  web: { width: 400, height: 300 },
  pdf: { width: 400, height: 300 },
  video: { width: 400, height: 300 },
  image: { width: 400, height: 300 },
  frame: { width: 400, height: 300 },
  prompt: { width: 280, height: 160 },
};

/**
 * Return the canonical default size hints for a node type.
 * Text and note nodes expose only a default width because their height is
 * content-driven at render time.
 */
export function getNodeDefaultSize(nodeType: string): NodeSize {
  return DEFAULT_SIZES[nodeType] || { width: 300, height: 200 };
}
