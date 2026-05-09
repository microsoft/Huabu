/**
 * Canvas → agent context helpers.
 *
 * Lives outside `tools/` because two unrelated callers need it:
 *  1. `tools/handlers/canvas-read.ts` (the `get_canvas_state` tool body).
 *  2. `agent.route.ts`, which injects an enrich-summary block for the
 *     user-selected nodes before the LLM call.
 *
 * Keeping it under `modules/agent/` (not `modules/storage/`) preserves
 * the framing: this is the "what does the agent see when it looks at
 * the canvas" layer, not raw storage IO.
 */

import { getCanvasStore } from '../storage/index.js';
// TODO: double check
/** Lightweight per-node preview shown in canvas summaries. */
export interface NodePreview {
  nodeId: string;
  type: string | undefined;
  title: string | undefined;
  parentId: string | undefined;
  /** Enrich-stage summary, when available. */
  summary?: string;
  /** Enrich-stage keywords, when available. */
  keywords?: string[];
  /**
   * Fallback 120-char content snippet when neither summary nor keywords
   * exist. Mutually exclusive with `summary`/`keywords`.
   */
  snippet?: string;
}

/**
 * Pick the most informative preview from a node's parsed metadata.
 * Prefers enrich-stage `summary` + `keywords`; falls back to a 120-char
 * content slice when those are missing.
 */
function extractPreviewFromParsed(
  meta: Record<string, unknown> | null,
  contentFallback?: string,
): { summary?: string; keywords?: string[]; snippet?: string } {
  if (meta) {
    const summary =
      typeof meta.summary === 'string' && meta.summary.trim()
        ? meta.summary.trim()
        : undefined;
    const keywords = Array.isArray(meta.keywords)
      ? (meta.keywords.filter(
          (k): k is string => typeof k === 'string' && k.trim().length > 0,
        ) as string[])
      : undefined;
    if (summary || (keywords && keywords.length > 0)) {
      return { summary, keywords };
    }
  }
  return {
    snippet: contentFallback ? contentFallback.slice(0, 120) : undefined,
  };
}

/**
 * Build lightweight preview summaries for canvas nodes.
 *
 * Each node gets at most a `summary`/`keywords` pair from preprocessed
 * metaJson, or a 120-char content snippet — never the full content.
 *
 * @param canvasId       Canvas to read.
 * @param filterNodeIds  When provided, only return previews for these
 *                       node IDs and skip the edge list (callers asking
 *                       for selected-node previews don't need edges).
 * @returns null when the canvas does not exist.
 */
export async function buildNodeSummaries(
  canvasId: string,
  filterNodeIds?: Set<string>,
): Promise<{
  nodes: NodePreview[];
  edges: Array<{ source: string; target: string }>;
  version: number;
} | null> {
  const store = getCanvasStore(canvasId);
  const canvas = store.read();
  if (!canvas) return null;

  const allNodes = (canvas.state.nodes ?? []) as Array<Record<string, unknown>>;
  const allEdges = (canvas.state.edges ?? []) as Array<Record<string, unknown>>;

  const nodes = filterNodeIds
    ? allNodes.filter((n) => filterNodeIds.has(n.id as string))
    : allNodes;

  const nodeSummaries: NodePreview[] = nodes.map((n) => {
    const data = n.data as Record<string, unknown> | undefined;
    const nodeId = n.id as string;
    const nodeContent = nodeId ? store.readNode(nodeId) : null;
    const content =
      nodeContent?.content ?? (data?.content as string | undefined);
    const meta = (nodeContent?.metadata ?? null) as Record<
      string,
      unknown
    > | null;
    const preview = extractPreviewFromParsed(meta, content);

    return {
      nodeId,
      type: (n.type ?? data?.type) as string | undefined,
      title: data?.label as string | undefined,
      parentId: n.parentId as string | undefined,
      ...preview,
    };
  });

  const edges = filterNodeIds
    ? []
    : allEdges.map((e) => ({
        source: e.source as string,
        target: e.target as string,
      }));

  return { nodes: nodeSummaries, edges, version: canvas.version };
}
