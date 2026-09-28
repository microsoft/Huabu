// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Structured chat-request envelope.
 *
 * The envelope is the single structured representation of "what context
 * does the agent see this turn", decoupled from how any particular
 * backend renders it. {@link buildChatEnvelope} performs all the
 * derivation with side effects (workspace-memory read, sketch/image
 * auto-snapshot, invoked-skill resolution, node-neighbourhood render);
 * the serializers (`serializeChatEnvelopeToPiAi`, and later ACP
 * variants) are pure functions over the result.
 *
 * Field grouping mirrors the orthogonal concerns the design calls
 * out:
 *   - `user`       — what the user directly typed / uploaded.
 *   - `skills`     — capabilities the user invoked this turn.
 *   - `focus`      — where the user pointed on the canvas: the selection
 *     (+ derived snapshots) and the anchor node (+ its neighbourhood).
 */

import { isInkOcrConfigured, recognizeInk } from './ink-ocr.js';
import { InkVisualPreparationError } from './prompt/required-ink-visuals.js';
import { getSkill } from '../../../prompt/index.js';
import { getNodeNeighbourhood } from '../../canvas/node-neighbourhood.js';
import { describeNode } from '../../canvas/node-prompt.js';
import {
  clusterToSvg,
  filterSketchStrokes,
  renderInkOcrRaster,
  snapshotNodesToArtifacts,
} from '../../canvas/snapshot-nodes.js';
import { space } from '../../storage/index.js';
import { isUserInvokableSkill } from '../skills.route.js';

import type { NodeSnapshot } from '../../storage/index.js';
import type { AgentNodePreview } from '../node-ref.js';
import type {
  AgentInputKind,
  ChatAttachment,
  ChatEnvelope,
  ResolvedSkill,
  VisibleCanvasGrounding,
  WireSelectionNode,
} from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';
import type { FastifyBaseLogger } from 'fastify';

export { InkVisualPreparationError } from './prompt/required-ink-visuals.js';
export type { ChatEnvelope, ResolvedSkill } from '@huabu/shared';

/**
 * Whether this turn carries any image content the model must be able to
 * accept — off-canvas uploads, selection image attachments, or composite
 * snapshots. Used by the vision guard when routing a workload onto the
 * Utility tier (see `skill-model-routing.ts` / `resolveForRole`).
 */
export function envelopeHasImage(envelope: ChatEnvelope): boolean {
  return (
    envelope.user.attachments.some((a) => a.type === 'image') ||
    envelope.focus.groundingVisual !== undefined ||
    envelope.focus.selection.imageAttachments.length > 0 ||
    envelope.focus.selection.snapshotAttachments.length > 0
  );
}

/** Inputs needed to assemble one chat turn's envelope. */
export interface ChatEnvelopeParams {
  /** Raw user prompt text. */
  content: string;
  inputKind?: AgentInputKind;
  /** User-uploaded (off-canvas) attachments from the request body. */
  attachments?: ChatAttachment[];
  groundingVisual?: VisibleCanvasGrounding;
  /** Wire selection (top-level + frame children) for this turn. */
  selectedNodes?: WireSelectionNode[];
  /** Anchor node for neighbourhood preamble (e.g. question nodes). */
  anchorNodeId?: string;
  /** User-invoked skill ids parsed from `/<id>` tokens. */
  invokedSkills?: string[];
  /** Current canvas id (null for canvas-less threads). */
  canvasId: string | null;
  /** Logger for non-fatal diagnostics (auto-snapshot failures, dropped skills). */
  logger: FastifyBaseLogger;
  signal?: AbortSignal;
}

/**
 * Collect image attachments from selected canvas nodes (including frame
 * children). Enables vision analysis when users select image nodes.
 */
function collectImageAttachments(nodes: WireSelectionNode[]): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];
  for (const node of nodes) {
    if (node.type === 'image' && node.src) {
      attachments.push({
        type: 'image',
        source: 'selection',
        url: node.src,
        label: node.label ?? `Image node ${node.id}`,
        originNodeId: node.id,
      });
    }
    if (node.children) {
      attachments.push(...collectImageAttachments(node.children));
    }
  }
  return attachments;
}

/**
 * Walk the wire selection (frame children included) and collect the
 * ids of every `sketch` node. Drives the auto-snapshot step.
 */
function collectSketchNodeIds(nodes: WireSelectionNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: WireSelectionNode[]) => {
    for (const n of list) {
      if (n.type === 'sketch') ids.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

/**
 * Walk the wire selection for sketch nodes that carry a PARTIAL stroke
 * selection (`strokeIds` present — the user lassoed a subset rather than
 * the whole node) and shape them into `snapshot_nodes` `strokeSubsets`
 * entries (a KEEP list — render only these strokes). Sketch nodes without
 * `strokeIds` render in full and never appear here.
 */
function collectSketchStrokeSubsets(
  nodes: WireSelectionNode[],
): { nodeId: string; strokeIds: string[] }[] {
  const out: { nodeId: string; strokeIds: string[] }[] = [];
  const walk = (list: WireSelectionNode[]) => {
    for (const n of list) {
      if (n.type === 'sketch' && n.strokeIds && n.strokeIds.length > 0) {
        out.push({ nodeId: n.id, strokeIds: n.strokeIds });
      }
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Flatten the wire selection (frame children included) into the L1
 * `AgentNodePreview` payload of `{ id, type, label?, filename, preview? }`.
 * The `preview` is picked server-side via the shared
 * {@link extractAgentNodePreview} ladder (`summary > content[:120] > src`)
 * — the SAME policy the node-neighbourhood uses — by reading each node's
 * stored record. Full content is still one tool call away; the preview is
 * only a scan hint. When `canvasId` is null there is no Space to read, so
 * refs fall back to bare `{ id, type, label?, filename }` (no preview).
 *
 * A selection is a named subset, so it is read as one — `readMany` over the
 * ids the wire already named, rather than a scan of the Space or a read per
 * node (§12.6.1).
 */
async function collectSelectedNodeRefs(
  nodes: WireSelectionNode[],
  canvasId: string | null,
): Promise<AgentNodePreview[]> {
  let records = new Map<string, NodeSnapshot>();
  if (canvasId) {
    try {
      records = await space(canvasId).nodes.readMany(
        collectSelectionNodeIds(nodes),
      );
    } catch {
      /* Space unreadable — refs stay bare. */
    }
  }
  const refs: AgentNodePreview[] = [];
  const walk = (list: WireSelectionNode[]) => {
    for (const n of list) {
      // Route through the shared assembler: the node carries whatever the
      // client wire already knows (label / src); anything missing (note
      // body / summary) is filled from the sidecar. One place owns
      // label + file + preview + rev for every server-side node context.
      refs.push(
        describeNode(
          {
            id: n.id,
            type: n.type,
            ...(n.label !== undefined ? { label: n.label } : {}),
            ...(n.src !== undefined ? { src: n.src } : {}),
          },
          'preview',
          records.get(n.id)?.record ?? null,
        ),
      );
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return refs;
}

/** Collect every node represented by the recursive selection wire. */
function collectSelectionNodeIds(nodes: WireSelectionNode[]): string[] {
  const seen = new Set<string>();
  const walk = (list: WireSelectionNode[]) => {
    for (const node of list) {
      seen.add(node.id);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return [...seen];
}

/**
 * Collect the ids the user **explicitly selected** (top-level only —
 * frame children are intentionally skipped).
 */
function collectSelectedNodeIds(nodes: WireSelectionNode[]): string[] {
  const seen = new Set<string>();
  for (const n of nodes) seen.add(n.id);
  return Array.from(seen);
}

/**
 * Resolve user-invoked skill ids to their bodies, dropping unknown or
 * non-invokable ids (logged for diagnostics).
 */
function resolveInvokedSkills(
  invokedSkills: string[] | undefined,
  logger: FastifyBaseLogger,
): ResolvedSkill[] {
  if (!invokedSkills || invokedSkills.length === 0) return [];
  const seen = new Set<string>();
  const injected: ResolvedSkill[] = [];
  const dropped: { id: string; reason: 'unknown' | 'not-invokable' }[] = [];
  for (const rawId of invokedSkills) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const skill = getSkill(id);
    if (!skill) {
      dropped.push({ id, reason: 'unknown' });
      continue;
    }
    if (!isUserInvokableSkill(skill)) {
      dropped.push({ id, reason: 'not-invokable' });
      continue;
    }
    injected.push({ id: skill.id, name: skill.name, body: skill.body });
  }
  if (dropped.length > 0) {
    logger.warn(
      { dropped },
      '[agent] invokedSkills: dropped ids (unknown or not user-invokable)',
    );
  }
  return injected;
}

/**
 * Derive the composite snapshot attachments for a selection and the set
 * of selection image ids those composites consumed.
 *
 * Auto-snapshots every selected sketch and image into PNG artifacts so
 * the LLM sees them as vision parts without calling `snapshot_nodes`.
 * The handler clusters per parent frame (≤ 200 px gap); a singleton
 * image short-circuits to its original artifact and is left to its
 * standalone attachment. Any image folded into a composite is marked
 * consumed so its standalone entry can be dropped — sending the same
 * image bytes twice tripped `413 Request Entity Too Large`.
 */
async function deriveSnapshotAttachments(
  selectedNodes: WireSelectionNode[],
  selectionImageAttachments: ChatAttachment[],
  canvasId: string,
  logger: FastifyBaseLogger,
  requireInkVisuals: boolean,
): Promise<{
  snapshotAttachments: ChatAttachment[];
  consumedImageIds: Set<string>;
  preparedNodes?: CanvasNode[];
}> {
  const snapshotAttachments: ChatAttachment[] = [];
  const consumedImageIds = new Set<string>();
  let preparedNodes: CanvasNode[] | undefined;

  const sketchIds = collectSketchNodeIds(selectedNodes);
  const strokeSubsets = collectSketchStrokeSubsets(selectedNodes);
  const partialNodeIds = new Set(strokeSubsets.map((f) => f.nodeId));
  const selectedImageIds = selectionImageAttachments
    .map((a) => a.originNodeId)
    .filter((id): id is string => typeof id === 'string');
  const snapshotIds = [...sketchIds, ...selectedImageIds];
  if (snapshotIds.length === 0) {
    return { snapshotAttachments, consumedImageIds };
  }

  try {
    if (requireInkVisuals) {
      const canvas = await space(canvasId).read();
      preparedNodes = structuredClone(
        (canvas?.state.nodes ?? []) as CanvasNode[],
      );
      const nodes = new Map(preparedNodes.map((node) => [node.id, node]));
      for (const subset of strokeSubsets) {
        const node = nodes.get(subset.nodeId);
        if (
          !node ||
          node.type !== 'sketch' ||
          !clusterToSvg([filterSketchStrokes(node, new Set(subset.strokeIds))])
        ) {
          throw new InkVisualPreparationError([subset.nodeId]);
        }
      }
    }
    const rasterResults = await snapshotNodesToArtifacts(
      {
        nodeIds: snapshotIds,
        canvasId,
        ...(strokeSubsets.length > 0 ? { strokeSubsets } : {}),
      },
      preparedNodes,
    );
    const selectedImageIdSet = new Set(selectedImageIds);
    for (const r of rasterResults) {
      // `originNodeIds` are NODE ids; split them into the sketch nodes vs
      // the backdrop image nodes contributing to this composite.
      const sketchNodeIds = r.originNodeIds.filter(
        (id) => !selectedImageIdSet.has(id),
      );
      const imageIds = r.originNodeIds.filter((id) =>
        selectedImageIdSet.has(id),
      );
      // Singleton image pass-through (no strokes, exactly one image —
      // handler short-circuited to that node's original artifact):
      // leave it to its standalone `selectionImageAttachments` entry.
      if (sketchNodeIds.length === 0 && imageIds.length === 1) continue;
      // Anything else is a composite owned by this snapshot.
      for (const iid of imageIds) consumedImageIds.add(iid);
      const nStrokes = sketchNodeIds.length;
      const nImages = imageIds.length;
      // Flag when any contributing stroke node was rendered from a
      // PARTIAL stroke selection, so the label tells the agent it is
      // seeing a subset (the lassoed strokes), not the whole node.
      const isPartial = sketchNodeIds.some((id) => partialNodeIds.has(id));
      const partialTag = isPartial ? ' — partial stroke selection' : '';
      const label =
        nStrokes === 0
          ? `Image cluster (${nImages} images)`
          : nImages > 0
            ? `Sketch cluster (${nStrokes} stroke node${
                nStrokes === 1 ? '' : 's'
              } + ${nImages} backdrop image${nImages === 1 ? '' : 's'})${partialTag}`
            : nStrokes === 1
              ? `Sketch (1 stroke node)${partialTag}`
              : `Sketch cluster (${nStrokes} stroke nodes)${partialTag}`;
      snapshotAttachments.push({
        type: 'image',
        source: 'selection',
        url: r.src,
        label,
        originNodeIds: r.originNodeIds,
      });
    }
    if (requireInkVisuals) {
      const representedIds = new Set(
        snapshotAttachments.flatMap((attachment) =>
          attachment.url ? (attachment.originNodeIds ?? []) : [],
        ),
      );
      const missingIds = [...partialNodeIds].filter(
        (nodeId) => !representedIds.has(nodeId),
      );
      if (missingIds.length > 0) {
        throw new InkVisualPreparationError(missingIds);
      }
    }
  } catch (err) {
    if (requireInkVisuals) {
      throw err instanceof InkVisualPreparationError
        ? err
        : new InkVisualPreparationError([...partialNodeIds], { cause: err });
    }
    logger.warn(
      { err, snapshotIds, canvasId },
      '[agent.route] selection auto-snapshot failed',
    );
  }

  return { snapshotAttachments, consumedImageIds, preparedNodes };
}

/**
 * Build the structured {@link ChatEnvelope} for one chat turn. Performs
 * all side-effectful derivation (memory read, auto-snapshot, skill
 * resolution, neighbourhood render); the result is a plain data object
 * the serializers turn into backend-specific messages.
 */
export async function buildChatEnvelope(
  params: ChatEnvelopeParams,
): Promise<ChatEnvelope> {
  const {
    content,
    inputKind,
    attachments,
    groundingVisual,
    selectedNodes,
    anchorNodeId,
    invokedSkills,
    canvasId,
    logger,
    signal,
  } = params;

  const requireInkVisuals = inputKind === 'ink-intent';
  const strokeSubsets = collectSketchStrokeSubsets(selectedNodes ?? []);
  if (requireInkVisuals && (!canvasId || strokeSubsets.length === 0)) {
    throw new InkVisualPreparationError(
      strokeSubsets.map((subset) => subset.nodeId),
    );
  }

  // Focus: anchor neighbourhood for anchored requests (Workspace memory
  // now rides in the agent's system prompt). Stored structured; both
  // backends serialize it the same way (a node is addressed by its `file=`
  // path). The anchor's own label is read from the store so the prompt can
  // name it.
  let anchor: ChatEnvelope['focus']['anchor'];
  if (anchorNodeId && canvasId) {
    const neighbourhood =
      (await getNodeNeighbourhood(canvasId, anchorNodeId)) ?? undefined;
    let label: string | undefined;
    try {
      const meta = (await space(canvasId).nodes.read(anchorNodeId))?.record;
      if (typeof meta?.label === 'string') label = meta.label;
    } catch {
      /* store unavailable — anchor still useful by id */
    }
    anchor = {
      nodeId: anchorNodeId,
      ...(label ? { label } : {}),
      ...(neighbourhood ? { neighbourhood } : {}),
    };
  }

  // Focus: selection refs + derived snapshot artifacts.
  const selectionRefs = selectedNodes
    ? await collectSelectedNodeRefs(selectedNodes, canvasId)
    : [];
  const selectionImageAttachments = selectedNodes
    ? collectImageAttachments(selectedNodes)
    : [];

  let snapshotAttachments: ChatAttachment[] = [];
  let consumedImageIds = new Set<string>();
  let inkRecognition: ChatEnvelope['focus']['selection']['inkRecognition'];
  if (selectedNodes && canvasId) {
    const derived = await deriveSnapshotAttachments(
      selectedNodes,
      selectionImageAttachments,
      canvasId,
      logger,
      requireInkVisuals,
    );
    snapshotAttachments = derived.snapshotAttachments;
    consumedImageIds = derived.consumedImageIds;
    if (
      requireInkVisuals &&
      derived.preparedNodes &&
      isInkOcrConfigured(logger)
    ) {
      signal?.throwIfAborted();
      let raster: Awaited<ReturnType<typeof renderInkOcrRaster>> | undefined;
      try {
        raster = await renderInkOcrRaster(derived.preparedNodes, strokeSubsets);
      } catch {
        logger.warn(
          { outcome: 'raster_error', nodeCount: strokeSubsets.length },
          '[ink-ocr] optional raster preparation failed',
        );
      }
      if (raster) {
        inkRecognition = await recognizeInk({ raster, logger, signal });
      }
      signal?.throwIfAborted();
    }
  }

  const dedupedImageAttachments =
    consumedImageIds.size === 0
      ? selectionImageAttachments
      : selectionImageAttachments.filter(
          (a) => !a.originNodeId || !consumedImageIds.has(a.originNodeId),
        );

  return {
    user: {
      text: content,
      ...(inputKind ? { inputKind } : {}),
      attachments: attachments ?? [],
    },
    skills: {
      invokedIds: invokedSkills ?? [],
      resolved: resolveInvokedSkills(invokedSkills, logger),
    },
    focus: {
      ...(groundingVisual ? { groundingVisual } : {}),
      selection: {
        refs: selectionRefs,
        selectedIds: selectedNodes ? collectSelectedNodeIds(selectedNodes) : [],
        imageAttachments: dedupedImageAttachments,
        snapshotAttachments,
        ...(inkRecognition ? { inkRecognition } : {}),
        strokeSubsets,
      },
      ...(anchor ? { anchor } : {}),
    },
  };
}
