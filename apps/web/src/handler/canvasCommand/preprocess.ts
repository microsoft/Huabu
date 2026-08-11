// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unified node preprocessing trigger.
 *
 * ALL node types (note/text/web/pdf/image/frame) flow through the single
 * POST /:canvasId/nodes/:nodeId/preprocess endpoint. The server pipeline
 * decides which stages to execute based on the node profile — the
 * client no longer maintains its own "which types need preprocessing"
 * whitelist or watched-field comparison (those duplicated the server's
 * `profiles` registry and tended to drift).
 *
 * This module replaces both the old `ingest.ts` and `resolveLabel.ts`.
 */

import { preprocessNode } from '@/api/canvas';

import type { ExecuteOriginator, PreprocessNodeResponse } from '@huabu/shared';
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
  /** Get the latest node state before applying an asynchronous result. */
  getNode: (nodeId: string) => Node | undefined;
  /** Current ordered Space cursor for non-commit response validation. */
  getVersion?: () => number | undefined;
  /** Silently patch node data without recording undo history. */
  patchNodeSilent: (nodeId: string, patch: Record<string, unknown>) => void;
  originator?: ExecuteOriginator;
  /** Route the durable commit through the shared HTTP/SSE version gate. */
  onMutationResponse?: (
    canvasId: string,
    response: PreprocessNodeResponse,
  ) => void;
};

// ─── Unified preprocessing entry point ───────────────────────────────────────

/**
 * Build the snapshot object sent to the server for a given node.
 * For frame nodes we include child labels so the Enrich stage can
 * generate a group-level label.
 *
 * Exported so the unload-time keepalive path (in `preprocessQueue`)
 * can produce the same snapshot shape without going through the full
 * `preprocessNodeIfNeeded` flow (which mutates ingestion state — a
 * no-op during page unload).
 */
export function buildPreprocessSnapshot(
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
      title: (data?.label as string) || undefined,
      childLabels,
      labelSource: (data?.labelSource as string) || undefined,
    };
  }

  if (nodeType === 'question') {
    // Question prompts live at `data.content` just like text / note
    // bodies, so the server pipeline can treat them uniformly when
    // generating a label.
    const content =
      typeof data?.content === 'string' ? data.content.trim() : '';
    return {
      title: (data?.label as string) || (data?.title as string) || undefined,
      labelSource: (data?.labelSource as string) || undefined,
      content: content || undefined,
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
  getNode,
  getVersion,
  patchNodeSilent,
  originator,
  onMutationResponse,
}: PreprocessHelperDeps): Promise<void> {
  const nodeType = node.type ?? '';

  setNodeIngestion(node.id, { status: 'pending', updatedAt: Date.now() });

  try {
    const snapshot = buildPreprocessSnapshot(node, getChildNodes);

    const response = await preprocessNode(canvasId, node.id, {
      nodeType,
      trigger: 'node_updated',
      snapshot,
      ...(originator ? { originator } : {}),
    });

    onMutationResponse?.(canvasId, response);

    // The request snapshot belongs to one concrete topology/type. A local
    // delete, type conversion, or intervening structural commit can replace
    // that target while the POST is in flight. In that case neither legacy
    // response fields nor ingestion state belong to the current node.
    const latestNode = getNode(node.id);
    if (!latestNode || (latestNode.type ?? '') !== nodeType) {
      clearNodeIngestion(node.id);
      return;
    }

    // Full commit responses are applied by the shared version gate. Replaying
    // these legacy response fields as a second patch would race SSE and can
    // overwrite a newer server projection. Older servers return only these
    // fields, so retain the direct-patch fallback when no commit is present.
    if (!response.commit) {
      // A non-committing result has no event to pass through the shared gate.
      // Apply it only at the exact server cursor it observed; an intervening
      // same-type delete/recreate or remote mutation otherwise makes the
      // projection stale even though the local node id/type still match.
      if (
        response.observedVersion !== undefined &&
        getVersion?.() !== response.observedVersion
      ) {
        clearNodeIngestion(node.id);
        return;
      }
      const patch: Record<string, unknown> = {};
      const latestData = latestNode.data as Record<string, unknown> | undefined;
      const latestLabel =
        typeof latestData?.label === 'string' ? latestData.label.trim() : '';
      const latestLabelSource = latestData?.labelSource;
      const latestLabelIsProtected =
        (latestLabelSource === 'user' || latestLabelSource === 'agent') &&
        latestLabel.length > 0;
      if (response.suggestedLabel && !latestLabelIsProtected) {
        patch.label = response.suggestedLabel;
        patch.labelSource = 'auto';
      }
      // Adopt the server-canonical `src` whenever the pipeline normalized
      // it (e.g. URL canonicalization for web, artifact URL rewrite for
      // pdf). The server only emits this field when it actually diverged
      // from the snapshot we sent, so any value here is meaningful.
      if (typeof response.src === 'string' && response.src.length > 0) {
        patch.src = response.src;
      }
      // Adopt the freshly-extracted body for node types whose preview reads
      // `data.content` directly (currently only `office`).
      if (typeof response.content === 'string') {
        patch.content = response.content;
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
    const latestNode = getNode(node.id);
    if (!latestNode || (latestNode.type ?? '') !== nodeType) {
      clearNodeIngestion(node.id);
      return;
    }
    setNodeIngestion(node.id, {
      status: 'error',
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
