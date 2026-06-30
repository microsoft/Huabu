/**
 * Canvas read-only tool handlers.
 * Design doc: docs/architecture/agent-architecture.md
 *
 * Split with the filesystem `read` tool: these handlers expose what
 * lives in `canvas.json` (position, size, parentId, visual style on
 * `data.style`, edge endpoints + `data.edgeStyle`, plus derived
 * spatial / topological metadata). Anything that round-trips through
 * `nodes/*.md` (label, type, src, content, summary, keywords) is
 * owned by `read` — agents should call `read("nodes/<filename>.md")`
 * for those.
 *
 * The actual computation (size normalization, absolute-position walk,
 * predicate filtering, distance / cluster / arrangement logic) lives
 * in `../canvas-spatial.ts`. These handlers are a thin tool-facing
 * shell that wraps the bundle into a JSON string.
 */

import {
  buildCanvasOutline,
  inspectEdges,
  inspectNodes,
} from '../../../canvas/canvas-spatial.js';

import type {
  getCanvasOutlineParamsSchema,
  inspectEdgesParamsSchema,
  inspectNodesParamsSchema,
} from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

// ---- Argument types ----
//
// Derived from the same TypeBox schemas we register with the LLM. The
// schema marks `canvasId` Optional, but every handler runs after the
// dispatcher's `resolveCanvasArgs` step, so we intersect a required
// `canvasId` and skip a redundant nullish check inside the body.

export type GetCanvasOutlineArgs = Static<
  typeof getCanvasOutlineParamsSchema
> & {
  canvasId: string;
};
export type InspectNodesArgs = Static<typeof inspectNodesParamsSchema> & {
  canvasId: string;
};
export type InspectEdgesArgs = Static<typeof inspectEdgesParamsSchema> & {
  canvasId: string;
};

export async function handleGetCanvasOutline(
  args: GetCanvasOutlineArgs,
): Promise<string> {
  const outline = buildCanvasOutline(args.canvasId, {
    includePreviews: args.includePreviews,
    includeStyle: args.includeStyle,
  });
  if (!outline) {
    throw new Error(`Canvas ${args.canvasId} not found`);
  }
  return JSON.stringify(outline);
}

export async function handleInspectNodes(
  args: InspectNodesArgs,
): Promise<string> {
  const { canvasId, ...predicates } = args;
  const result = inspectNodes(canvasId, predicates);
  // `inspectNodes` returns either a result object or `{ error }` when a
  // referenced node is missing. Promote the error case to a throw so
  // pi-agent-core flags the tool result as `isError: true`.
  if ('error' in result) {
    throw new Error(result.error);
  }
  return JSON.stringify(result);
}

export async function handleInspectEdges(
  args: InspectEdgesArgs,
): Promise<string> {
  const { canvasId, ...predicates } = args;
  const result = inspectEdges(canvasId, predicates);
  if ('error' in result) {
    throw new Error(result.error);
  }
  return JSON.stringify(result);
}
