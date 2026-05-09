/**
 * Canvas read-only tool handlers.
 *
 * Today: `get_node_geometry`, `get_canvas_state`. Future read tools
 * (`get_canvas_outline`, `get_node_neighbors`, `search_nodes`, etc.)
 * land here too — anything the agent calls to *understand* the canvas
 * without mutating it.
 *
 * Split with the filesystem `read` tool: `get_node_geometry` returns
 * only fields that live in `canvas.json` and are NOT in the node's
 * markdown frontmatter (position, size, parent, z-order rank, style).
 * Anything that round-trips through `nodes/<id>.md` (title/label, type,
 * src, content, summary, keywords) is owned by `read` — agents should
 * call `read("<canvasId>/nodes/<nodeId>.md")` for those.
 */

import { getCanvasStore } from '../../../storage/index.js';
import { buildNodeSummaries } from '../../canvas-context.js';

import type {
  getCanvasStateParamsSchema,
  getNodeGeometryParamsSchema,
} from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

// ---- Argument types ----
//
// Derived from the same TypeBox schemas we register with the LLM. The
// schema marks `canvasId` Optional, but every handler runs after the
// dispatcher's `resolveCanvasArgs` step, so we intersect a required
// `canvasId` and skip a redundant nullish check inside the body.

export type GetNodeGeometryArgs = Static<typeof getNodeGeometryParamsSchema> & {
  canvasId: string;
};
export type GetCanvasStateArgs = Static<typeof getCanvasStateParamsSchema> & {
  canvasId: string;
};

export async function handleGetNodeGeometry(
  args: GetNodeGeometryArgs,
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

  // `style` lives on `data.style` in canvas.json. We surface it here
  // because no other tool can reach it: it never round-trips through
  // the node markdown frontmatter (which carries content-shaped fields
  // like title/type/src/summary). Other `data.*` keys are intentionally
  // dropped — they belong to the `read` tool's frontmatter view.
  const data = node.data as Record<string, unknown> | undefined;
  const style = data && typeof data === 'object' ? data.style : undefined;

  return JSON.stringify({
    id: node.id,
    position: node.position,
    width: node.width,
    height: node.height,
    parentId: node.parentId,
    ...(style !== undefined ? { style } : {}),
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
