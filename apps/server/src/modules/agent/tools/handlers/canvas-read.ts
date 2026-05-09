/**
 * Canvas read-only tool handlers.
 *
 * Today: `get_node_detail`, `get_canvas_state`. Future read tools
 * (`get_canvas_outline`, `get_node_neighbors`, `search_nodes`, etc.)
 * land here too — anything the agent calls to *understand* the canvas
 * without mutating it.
 */

import { getCanvasStore } from '../../../storage/index.js';
import { buildNodeSummaries } from '../../canvas-context.js';

import type {
  getCanvasStateParamsSchema,
  getNodeDetailParamsSchema,
} from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

// ---- Argument types ----
//
// Derived from the same TypeBox schemas we register with the LLM. The
// schema marks `canvasId` Optional, but every handler runs after the
// dispatcher's `resolveCanvasArgs` step, so we intersect a required
// `canvasId` and skip a redundant nullish check inside the body.

export type GetNodeDetailArgs = Static<typeof getNodeDetailParamsSchema> & {
  canvasId: string;
};
export type GetCanvasStateArgs = Static<typeof getCanvasStateParamsSchema> & {
  canvasId: string;
};

export async function handleGetNodeDetail(
  args: GetNodeDetailArgs,
): Promise<string> {
  const store = getCanvasStore(args.canvasId);
  const canvas = store.read();
  if (!canvas) {
    return JSON.stringify({ error: `Canvas ${args.canvasId} not found` });
  }

  const nodes = (canvas.state.nodes ?? []) as Array<Record<string, unknown>>;
  const node = nodes.find((n) => n.id === args.nodeId);
  if (!node) {
    return JSON.stringify({
      error: `Node ${args.nodeId} not found in canvas ${args.canvasId}`,
    });
  }

  const data = node.data as Record<string, unknown> | undefined;
  const nodeContent = store.readNode(args.nodeId);
  const persistedContent = nodeContent?.content;
  const inlineContent = data?.content as string | undefined;
  // Prefer persisted markdown, but if it is missing OR an empty string
  // fall back to whatever inline content the canvas JSON still has.
  // Plain `??` would treat "" as a valid value and skip the fallback.
  const content =
    persistedContent && persistedContent.length > 0
      ? persistedContent
      : (inlineContent ?? persistedContent ?? '');

  const nodeType = (node.type ?? data?.type) as string | undefined;
  const isTextBearing = nodeType === 'note' || nodeType === 'text';
  const warning =
    isTextBearing && content.length === 0
      ? 'No persisted content found for this node.'
      : undefined;

  return JSON.stringify({
    id: node.id,
    type: nodeType,
    label: data?.label,
    content,
    src: data?.src ?? nodeContent?.src ?? undefined,
    position: node.position,
    width: node.width,
    height: node.height,
    parentId: node.parentId,
    ...(warning ? { warning } : {}),
  });
}

export async function handleGetCanvasState(
  args: GetCanvasStateArgs,
): Promise<string> {
  const result = await buildNodeSummaries(args.canvasId);
  if (!result) {
    return JSON.stringify({ error: `Canvas ${args.canvasId} not found` });
  }

  return JSON.stringify({
    canvasId: args.canvasId,
    version: result.version,
    nodeCount: result.nodes.length,
    edgeCount: result.edges.length,
    nodes: result.nodes,
    edges: result.edges,
  });
}
