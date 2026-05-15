/**
 * Selection → Sketch Attachments
 *
 * When the user has sketch nodes in the canvas selection at chat-send
 * time, this module turns each spatial cluster into one image
 * attachment so the chat agent can `see` the sketch via the existing
 * vision pipeline (`agent.route.ts:buildUserContent` resolves the
 * dataURL straight into a vision content part).
 *
 * Cluster boundaries respect frame parenthood: two sketch strokes
 * whose bboxes overlap end up in *different* clusters when they live
 * inside different frames. This matches the user's mental model —
 * frames are explicit containers, so an "intersection by accident"
 * across frames should not collapse two separate gestures into one
 * picture.
 *
 * The attachment carries `originNodeIds` listing every sketch node
 * that contributed strokes, so the agent can follow up with
 * `inspect_nodes` / `get_canvas_outline` to pull surrounding context
 * (parent frame, neighbours, position) without us shipping that
 * geometry up-front in the prompt.
 */

import { clusterSketches } from './sketchClustering';
import { renderSketchClusterToPng } from './sketchToImage';

import type {
  ChatAttachment,
  SketchNodeRef,
  SketchStroke,
} from '@sediment/shared';
import type { Node } from '@xyflow/react';

/** A React Flow node that carries sketch data. Narrowed in the helpers. */
type AnyNode = Node;

interface SketchData {
  strokes?: SketchStroke[];
  initialSize?: { width: number; height: number };
}

/** Type-narrow predicate for sketch nodes. */
function isSketchNode(n: AnyNode): boolean {
  return n.type === 'sketch';
}

/** Effective on-canvas size for a node (measured > styled > 0). */
function effectiveSize(n: AnyNode): { width: number; height: number } {
  const data = n.data as SketchData | undefined;
  const w = n.width ?? data?.initialSize?.width ?? 0;
  const h = n.height ?? data?.initialSize?.height ?? 0;
  return { width: w, height: h };
}

/**
 * Walk the selection: every directly selected sketch + every sketch
 * descendant of any selected frame (recursive — frames inside frames
 * also expanded). Deduped by node id.
 */
function collectSelectedSketchNodes(
  selectedIds: Set<string>,
  allNodes: AnyNode[],
): AnyNode[] {
  const collected = new Map<string, AnyNode>();

  const walkFrame = (frameId: string): void => {
    for (const child of allNodes) {
      if (child.parentId !== frameId) continue;
      if (isSketchNode(child)) collected.set(child.id, child);
      if (child.type === 'frame') walkFrame(child.id);
    }
  };

  for (const n of allNodes) {
    if (!selectedIds.has(n.id)) continue;
    if (isSketchNode(n)) collected.set(n.id, n);
    if (n.type === 'frame') walkFrame(n.id);
  }
  return [...collected.values()];
}

/**
 * Group sketch nodes by their parent frame, then run the existing
 * spatial clusterer inside each group. Two sketches that overlap
 * in flow space but live in different frames therefore stay in
 * separate clusters.
 *
 * Returns each cluster as an ordered list of the original React Flow
 * nodes (the renderer needs `data.strokes`, `data.initialSize`,
 * `position`, `width`, `height` — all of which live on the node).
 */
function clusterSketchesScopedByFrame(
  sketches: AnyNode[],
): Array<{ nodes: AnyNode[] }> {
  // Bucket by parent (use a sentinel for root-level so all-undefined
  // does not collapse with all-named).
  const buckets = new Map<string, AnyNode[]>();
  for (const n of sketches) {
    const key = n.parentId ?? '__root__';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(n);
    else buckets.set(key, [n]);
  }

  const out: Array<{ nodes: AnyNode[] }> = [];
  for (const group of buckets.values()) {
    // `clusterSketches` only consults `rect`; the other `SketchNodeRef`
    // fields are required by the interface but unused by the algorithm,
    // so we hand it a thin shim instead of building real refs.
    const refs: SketchNodeRef[] = group.map((n) => {
      const { width, height } = effectiveSize(n);
      const data = n.data as SketchData | undefined;
      return {
        id: n.id,
        rect: { x: n.position.x, y: n.position.y, width, height },
        points: [],
        initialSize: data?.initialSize ?? { width: 0, height: 0 },
      };
    });
    const clusters = clusterSketches(refs);
    const nodeById = new Map(group.map((n) => [n.id, n]));
    for (const cluster of clusters) {
      const clusterNodes = cluster.strokeIds
        .map((id) => nodeById.get(id))
        .filter((n): n is AnyNode => Boolean(n));
      if (clusterNodes.length > 0) out.push({ nodes: clusterNodes });
    }
  }
  return out;
}

/**
 * Build one image attachment per spatial sketch cluster found in the
 * current selection. Returns `[]` (zero allocation) when the selection
 * carries no sketch nodes.
 *
 * Each attachment's `originNodeIds` is the full list of sketch node
 * ids that contributed strokes to that cluster, so the agent can map
 * the rasterised image back to addressable canvas nodes.
 */
export async function buildSketchAttachmentsFromSelection(
  selectedNodeIds: ReadonlyArray<string> | ReadonlySet<string>,
  allNodes: AnyNode[],
): Promise<ChatAttachment[]> {
  const sel =
    selectedNodeIds instanceof Set
      ? (selectedNodeIds as Set<string>)
      : new Set(selectedNodeIds as ReadonlyArray<string>);
  if (sel.size === 0) return [];
  const sketches = collectSelectedSketchNodes(sel, allNodes);
  if (sketches.length === 0) return [];

  const clusters = clusterSketchesScopedByFrame(sketches);
  const attachments: ChatAttachment[] = [];

  for (const cluster of clusters) {
    let dataUrl: string | null;
    try {
      dataUrl = await renderSketchClusterToPng(cluster.nodes);
    } catch (err) {
      // Defensive: a cluster that fails to rasterise must not block
      // the rest. The chat send still succeeds; the model just won't
      // see *that* cluster's picture.
      console.error('[sketchAttachments] cluster render failed', err);
      continue;
    }
    if (!dataUrl) continue;

    const ids = cluster.nodes.map((n) => n.id);
    const label =
      ids.length === 1
        ? 'Sketch (1 stroke node)'
        : `Sketch cluster (${ids.length} stroke nodes)`;

    attachments.push({
      type: 'image',
      source: 'selection',
      url: dataUrl,
      label,
      originNodeIds: ids,
    });
  }

  return attachments;
}
