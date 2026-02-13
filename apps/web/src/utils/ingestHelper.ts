import { upsertNode } from '@/api/canvas';

import type { Node } from '@xyflow/react';

export type NodeIngestionStatus = 'pending' | 'success' | 'error';

export type NodeIngestionInfo = {
  status: NodeIngestionStatus;
  updatedAt: number;
  error?: string;
};

export type IngestHelperDeps = {
  canvasId: string;
  node: Node;

  setNodeIngestion: (nodeId: string, info: NodeIngestionInfo) => void;
  clearNodeIngestion: (nodeId: string) => void;
  getNodeById: (nodeId: string) => Node | undefined;
  updateNodeDataLocal: (nodeId: string, patch: Record<string, unknown>) => void;
};

export function needsIngestion(nodeType: string): boolean {
  return ['note', 'text', 'web', 'pdf'].includes(nodeType);
}

function getStringDataField(node: Node, field: string): string {
  const data = node.data as Record<string, unknown> | undefined;
  const value = data?.[field];
  return typeof value === 'string' ? value : '';
}

/**
 * Decide whether a node update should trigger ingestion.
 * Key fields:
 * - note/text: content
 * - web/pdf: src
 */
export function shouldIngestOnUpdate(prevNode: Node, nextNode: Node): boolean {
  const nextType = nextNode.type ?? '';
  if (!needsIngestion(nextType)) return false;

  if ((prevNode.type ?? '') !== nextType) return true;

  if (nextType === 'note' || nextType === 'text') {
    return (
      getStringDataField(prevNode, 'content') !==
      getStringDataField(nextNode, 'content')
    );
  }

  if (nextType === 'web' || nextType === 'pdf') {
    return (
      getStringDataField(prevNode, 'src') !==
      getStringDataField(nextNode, 'src')
    );
  }

  return false;
}

export async function ingestNodeIfNeeded({
  canvasId,
  node,
  setNodeIngestion,
  clearNodeIngestion,
  getNodeById,
  updateNodeDataLocal,
}: IngestHelperDeps): Promise<void> {
  if (!needsIngestion(node.type ?? '')) return;

  setNodeIngestion(node.id, {
    status: 'pending',
    updatedAt: Date.now(),
  });

  const nodeData = node.data as Record<string, unknown> | undefined;

  try {
    const response = await upsertNode(canvasId, node.id, {
      type: node.type as 'note' | 'text' | 'web' | 'pdf',
      title: (nodeData?.label as string) ?? (nodeData?.title as string),
      content: nodeData?.content as string,
      src: nodeData?.src as string,
      sourceId: (nodeData?.sourceId as string) || undefined,
    });

    if (response.sourceId) {
      updateNodeDataLocal(node.id, { sourceId: response.sourceId });
    }

    // Optionally apply server-suggested label (e.g. parsed PDF/web title).
    // Only overwrite when the current label is empty.
    if (response.success && response.suggestedLabel) {
      const suggestedLabel = response.suggestedLabel.trim();
      if (suggestedLabel.length > 0) {
        const currentNode = getNodeById(node.id);
        if (currentNode) {
          const currentLabel =
            typeof (currentNode.data as Record<string, unknown> | undefined)
              ?.label === 'string'
              ? ((currentNode.data as Record<string, unknown>).label as string)
              : '';

          if (currentLabel.trim().length === 0) {
            // Do not re-trigger ingestion when applying server-suggested metadata.
            updateNodeDataLocal(node.id, { label: suggestedLabel });
          }
        }
      }
    }

    if (response.success) {
      // Keep the ingestion map small; UI only needs pending.
      clearNodeIngestion(node.id);
      return;
    }

    setNodeIngestion(node.id, {
      status: 'error',
      updatedAt: Date.now(),
      error: response.error ?? 'Unknown ingestion error',
    });

    console.error(
      'Node ingestion did not complete successfully:',
      node.id,
      response.error,
    );
  } catch (error) {
    setNodeIngestion(node.id, {
      status: 'error',
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
    console.error('Failed to ingest node:', node.id, error);
  }
}
