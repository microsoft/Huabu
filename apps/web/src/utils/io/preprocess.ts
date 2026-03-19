/**
 * Unified node preprocessing trigger.
 *
 * Replaces both `ingest.ts` (knowledge ingestion for note/text/web/pdf)
 * and `resolveLabel.ts` (LLM label for image/frame) with a single helper.
 *
 * All node types flow through the same API call — the server pipeline
 * decides which stages to execute based on the node profile.
 */

import { resolveLabel, upsertNode } from '@/api/canvas';

import type { ResolveLabelRequest } from '@sediment/shared';
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
  getNodeById: (nodeId: string) => Node | undefined;
  /** Get all direct children of a frame node. */
  getChildNodes: (frameId: string) => Node[];
  /** Silently patch node data without recording undo history. */
  patchNodeSilent: (nodeId: string, patch: Record<string, unknown>) => void;
};

// ─── Node types that participate in preprocessing ────────────────────────────

const INGEST_TYPES = new Set(['note', 'text', 'web', 'pdf']);
const LABEL_RESOLVE_TYPES = new Set(['image', 'frame']);

/** Returns true when this node type has any preprocessing behavior. */
export function needsPreprocessing(nodeType: string): boolean {
  return INGEST_TYPES.has(nodeType) || LABEL_RESOLVE_TYPES.has(nodeType);
}

/** Returns true when a node type needs knowledge-store ingestion. */
export function needsIngestion(nodeType: string): boolean {
  return INGEST_TYPES.has(nodeType);
}

/** Returns true when a node type benefits from LLM label resolution. */
export function needsLabelResolve(nodeType: string): boolean {
  return LABEL_RESOLVE_TYPES.has(nodeType);
}

// ─── Dirty-field detection ───────────────────────────────────────────────────

function getStringDataField(node: Node, field: string): string {
  const data = node.data as Record<string, unknown> | undefined;
  const value = data?.[field];
  return typeof value === 'string' ? value : '';
}

/**
 * Decide whether a node update should trigger preprocessing.
 * Unified replacement for `shouldIngestOnUpdate` and `needsLabelResolve` checks.
 */
export function shouldPreprocessOnUpdate(
  prevNode: Node,
  nextNode: Node,
): boolean {
  const nextType = nextNode.type ?? '';
  if (!needsPreprocessing(nextType)) return false;
  if ((prevNode.type ?? '') !== nextType) return true;

  if (nextType === 'note' || nextType === 'text') {
    return (
      getStringDataField(prevNode, 'content') !==
      getStringDataField(nextNode, 'content')
    );
  }

  if (nextType === 'web' || nextType === 'pdf' || nextType === 'image') {
    return (
      getStringDataField(prevNode, 'src') !==
      getStringDataField(nextNode, 'src')
    );
  }

  // frame: label changes in children are handled by the separate
  // triggerLabelResolve callback, not here.
  return false;
}

// ─── Unified preprocessing entry point ───────────────────────────────────────

/**
 * Preprocess a node if needed. Routes to the appropriate server endpoint
 * based on node type:
 * - note/text/web/pdf → PUT /canvas/:id/nodes/:nodeId (upsertNode)
 * - image/frame → POST /canvas/resolve-label (resolveLabel)
 *
 * Both endpoints now internally use the same preprocessing pipeline.
 */
export async function preprocessNodeIfNeeded({
  canvasId,
  node,
  setNodeIngestion,
  clearNodeIngestion,
  getNodeById,
  getChildNodes,
  patchNodeSilent,
}: PreprocessHelperDeps): Promise<void> {
  const nodeType = node.type ?? '';
  if (!needsPreprocessing(nodeType)) return;

  const nodeData = node.data as Record<string, unknown> | undefined;

  // ── Ingest path (note, text, web, pdf) ──
  if (needsIngestion(nodeType)) {
    setNodeIngestion(node.id, { status: 'pending', updatedAt: Date.now() });

    try {
      const currentLabel = (nodeData?.label as string) || '';
      const labelSource = nodeData?.labelSource as string | undefined;
      const isAutoLabel = !labelSource || labelSource === 'auto';
      const titleToSend = isAutoLabel
        ? undefined
        : currentLabel || (nodeData?.title as string) || undefined;

      const response = await upsertNode(canvasId, node.id, {
        type: nodeType as 'note' | 'text' | 'web' | 'pdf',
        title: titleToSend,
        content: (nodeData?.content as string) || undefined,
        src: (nodeData?.src as string) || undefined,
        sourceId: (nodeData?.sourceId as string) || undefined,
      });

      if (response.sourceId) {
        patchNodeSilent(node.id, { sourceId: response.sourceId });
      }

      if (response.success && response.suggestedLabel) {
        applySuggestedLabel(
          node.id,
          response.suggestedLabel,
          getNodeById,
          patchNodeSilent,
        );
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
    return;
  }

  // ── Label-resolve path (image, frame) ──
  if (needsLabelResolve(nodeType)) {
    // Never overwrite user-set labels
    if (nodeData?.labelSource === 'user') return;

    let request: ResolveLabelRequest | null = null;

    if (nodeType === 'image') {
      const src = typeof nodeData?.src === 'string' ? nodeData.src : '';
      if (!src) return;
      request = { type: 'image', src };
    } else if (nodeType === 'frame') {
      const children = getChildNodes(node.id);
      const childLabels = children
        .map((c) => {
          const cData = c.data as Record<string, unknown> | undefined;
          const label =
            typeof cData?.label === 'string' ? (cData.label as string) : '';
          return label.trim();
        })
        .filter((l) => l.length > 0);
      if (childLabels.length < 1) return;
      request = { type: 'frame', childLabels };
    }

    if (!request) return;

    try {
      const response = await resolveLabel(request);
      if (!response.suggestedLabel) return;

      applySuggestedLabel(
        node.id,
        response.suggestedLabel,
        getNodeById,
        patchNodeSilent,
      );
    } catch (error) {
      console.warn('Failed to resolve label for node:', node.id, error);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function applySuggestedLabel(
  nodeId: string,
  suggestedLabel: string,
  getNodeById: (id: string) => Node | undefined,
  patchNodeSilent: (nodeId: string, patch: Record<string, unknown>) => void,
): void {
  const trimmed = suggestedLabel.trim();
  if (trimmed.length === 0) return;

  const currentNode = getNodeById(nodeId);
  if (!currentNode) return;

  const currentData = currentNode.data as Record<string, unknown> | undefined;
  const currentLabel =
    typeof currentData?.label === 'string' ? (currentData.label as string) : '';
  const labelSource = currentData?.labelSource as string | undefined;
  const isAutoLabel = !labelSource || labelSource === 'auto';

  if (currentLabel.trim().length === 0 || isAutoLabel) {
    patchNodeSilent(nodeId, { label: trimmed, labelSource: 'auto' });
  }
}
