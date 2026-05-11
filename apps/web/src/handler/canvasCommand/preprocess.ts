/**
 * Unified node preprocessing trigger.
 *
 * ALL node types (note/text/web/pdf/image/frame) flow through the single
 * POST /:canvasId/nodes/:nodeId/preprocess endpoint. The server pipeline
 * decides which stages to execute based on the node profile.
 *
 * This module replaces both the old `ingest.ts` and `resolveLabel.ts`.
 */

import { preprocessNode } from '@/api/canvas';

import type { Node } from '@xyflow/react';

// Re-export the ingestion status types (unchanged interface for canvasStore)
export type NodeIngestionStatus = 'pending' | 'success' | 'error';

export type NodeIngestionInfo = {
  status: NodeIngestionStatus;
  updatedAt: number;
  error?: string;
};

export type PreprocessHelperDeps = {
  canvasId: string;
  node: Node;

  setNodeIngestion: (nodeId: string, info: NodeIngestionInfo) => void;
  clearNodeIngestion: (nodeId: string) => void;
  /** Get all direct children of a frame node. */
  getChildNodes: (frameId: string) => Node[];
  /** Silently patch node data without recording undo history. */
  patchNodeSilent: (nodeId: string, patch: Record<string, unknown>) => void;
};

// ─── Node types that participate in preprocessing ────────────────────────────

const PREPROCESS_TYPES = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'image',
  'frame',
]);

/** Returns true when this node type has any preprocessing behavior. */
export function needsPreprocessing(nodeType: string): boolean {
  return PREPROCESS_TYPES.has(nodeType);
}

// ─── Dirty-field detection ───────────────────────────────────────────────────

function getStringDataField(node: Node, field: string): string {
  const data = node.data as Record<string, unknown> | undefined;
  const value = data?.[field];
  return typeof value === 'string' ? value : '';
}

/**
 * Decide whether a node update should trigger preprocessing.
 *
 * Returns true when a watched data field has changed for this node type.
 * Frame nodes always return false here — frame label re-resolution is
 * triggered by child label changes (see command handlers).
 */
export function shouldPreprocessOnUpdate(
  prevNode: Node,
  nextNode: Node,
): boolean {
  const nextType = nextNode.type ?? '';
  if (!needsPreprocessing(nextType)) return false;
  if ((prevNode.type ?? '') !== nextType) return true;

  const labelChanged =
    getStringDataField(prevNode, 'label') !==
    getStringDataField(nextNode, 'label');

  if (nextType === 'note' || nextType === 'text') {
    return (
      getStringDataField(prevNode, 'content') !==
        getStringDataField(nextNode, 'content') || labelChanged
    );
  }

  if (nextType === 'web' || nextType === 'pdf' || nextType === 'image') {
    return (
      getStringDataField(prevNode, 'src') !==
        getStringDataField(nextNode, 'src') || labelChanged
    );
  }

  // frame: label changes in children trigger preprocessing via
  // the preprocessNodes array in command handlers, not here.
  return false;
}

// ─── Unified preprocessing entry point ───────────────────────────────────────

/**
 * Build the snapshot object sent to the server for a given node.
 * For frame nodes we include child labels so the Enrich stage can
 * generate a group-level label.
 */
function buildSnapshot(
  node: Node,
  getChildNodes: (frameId: string) => Node[],
): Record<string, unknown> {
  const data = node.data as Record<string, unknown> | undefined;
  const nodeType = node.type ?? '';

  if (nodeType === 'frame') {
    const children = getChildNodes(node.id);
    const childLabels = children
      .map((c) => {
        const cData = c.data as Record<string, unknown> | undefined;
        const label =
          typeof cData?.label === 'string' ? (cData.label as string) : '';
        return label.trim();
      })
      .filter((l) => l.length > 0);
    return {
      childLabels,
      labelSource: (data?.labelSource as string) || undefined,
    };
  }

  return {
    title: (data?.label as string) || (data?.title as string) || undefined,
    labelSource: (data?.labelSource as string) || undefined,
    content: (data?.content as string) || undefined,
    src: (data?.src as string) || undefined,
  };
}

/**
 * Preprocess a single node through the unified server endpoint.
 *
 * All node types use POST /:canvasId/nodes/:nodeId/preprocess.
 * The server pipeline decides which stages (extract, enrich, persist, etc.)
 * to execute based on the node profile.
 */
export async function preprocessNodeIfNeeded({
  canvasId,
  node,
  setNodeIngestion,
  clearNodeIngestion,
  getChildNodes,
  patchNodeSilent,
}: PreprocessHelperDeps): Promise<void> {
  const nodeType = node.type ?? '';
  if (!needsPreprocessing(nodeType)) return;

  const nodeData = node.data as Record<string, unknown> | undefined;

  // For frame nodes: skip if there are no meaningful child labels.
  if (nodeType === 'frame') {
    const children = getChildNodes(node.id);
    const hasLabels = children.some((c) => {
      const cData = c.data as Record<string, unknown> | undefined;
      const label = typeof cData?.label === 'string' ? cData.label : '';
      return label.trim().length > 0;
    });
    if (!hasLabels) return;
  }

  // For image nodes: skip if there is no src.
  if (nodeType === 'image') {
    const src = typeof nodeData?.src === 'string' ? nodeData.src : '';
    if (!src) return;
  }

  setNodeIngestion(node.id, { status: 'pending', updatedAt: Date.now() });

  try {
    const snapshot = buildSnapshot(node, getChildNodes);

    const response = await preprocessNode(canvasId, node.id, {
      nodeType,
      trigger: 'node_updated',
      snapshot,
    });

    // Apply results from the backend.
    const patch: Record<string, unknown> = {};
    if (response.suggestedLabel) {
      patch.label = response.suggestedLabel;
      patch.labelSource = 'auto';
    }
    if (typeof response.summary === 'string' && response.summary.length > 0) {
      patch.summary = response.summary;
    }
    if (Array.isArray(response.keywords) && response.keywords.length > 0) {
      patch.keywords = response.keywords;
    }
    if (Object.keys(patch).length > 0) {
      patchNodeSilent(node.id, patch);
    }

    if (response.success || response.error?.includes('EMPTY_CONTENT')) {
      clearNodeIngestion(node.id);
      return;
    }

    setNodeIngestion(node.id, {
      status: 'error',
      updatedAt: Date.now(),
      error: response.error ?? 'Unknown preprocessing error',
    });
  } catch (error) {
    setNodeIngestion(node.id, {
      status: 'error',
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
