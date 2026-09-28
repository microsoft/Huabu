// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { AgentBinding, AgentChatContext, AgentMode } from '@huabu/shared';
import type { Node } from '@xyflow/react';

export type InkQuestionTarget = {
  nodeId: string;
  threadId: string;
  mode?: AgentMode;
  binding?: AgentBinding;
};

export type InkSubmissionCandidate =
  | {
      kind: 'ready';
      sourceCount: number;
      selectedNodeIds: string[];
      strokeSelection: Record<string, string[]>;
      target: InkQuestionTarget | null;
    }
  | {
      kind: 'blocked';
      reason:
        | 'no-ink'
        | 'multiple-question-targets'
        | 'invalid-question-target';
      sourceCount: number;
    };

function copyStrokeSelection(
  selection: Record<string, readonly string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(selection)
      .filter(([, strokeIds]) => strokeIds.length > 0)
      .map(([nodeId, strokeIds]) => [nodeId, [...strokeIds]]),
  );
}

function isValidPersistedBinding(
  value: unknown,
): value is AgentBinding | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const binding = value as Record<string, unknown>;
  if (binding.kind === 'internal') return true;
  return (
    binding.kind === 'external' &&
    typeof binding.profileId === 'string' &&
    binding.profileId.trim().length > 0 &&
    typeof binding.alias === 'string' &&
    binding.alias.trim().length > 0
  );
}

export function deriveInkSubmissionCandidate(
  nodes: readonly Node[],
  selection: Record<string, readonly string[]>,
): InkSubmissionCandidate {
  const strokeSelection = copyStrokeSelection(selection);
  const selectedNodes = nodes.filter((node) => node.selected);
  const questionTargets = selectedNodes.filter(
    (node) => node.type === 'question',
  );
  const selectedNodeIds = selectedNodes
    .filter((node) => node.type !== 'question')
    .map((node) => node.id);
  const sourceCount = new Set([
    ...selectedNodeIds,
    ...Object.keys(strokeSelection),
  ]).size;

  if (Object.keys(strokeSelection).length === 0) {
    return { kind: 'blocked', reason: 'no-ink', sourceCount };
  }
  if (questionTargets.length > 1) {
    return {
      kind: 'blocked',
      reason: 'multiple-question-targets',
      sourceCount,
    };
  }

  const question = questionTargets[0];
  if (!question) {
    return {
      kind: 'ready',
      sourceCount,
      selectedNodeIds,
      strokeSelection,
      target: null,
    };
  }

  const data = question.data as Record<string, unknown>;
  const threadId =
    typeof data.threadId === 'string' ? data.threadId.trim() : '';
  if (!threadId || !isValidPersistedBinding(data.agentBinding)) {
    return {
      kind: 'blocked',
      reason: 'invalid-question-target',
      sourceCount,
    };
  }
  return {
    kind: 'ready',
    sourceCount,
    selectedNodeIds,
    strokeSelection,
    target: {
      nodeId: question.id,
      threadId,
      ...(data.agentMode === 'operate' || data.agentMode === 'ask'
        ? { mode: data.agentMode }
        : {}),
      ...(data.agentBinding ? { binding: data.agentBinding } : {}),
    },
  };
}

export function inkSelectionIdentity(
  canvasId: string,
  nodes: readonly Node[],
  selection: Record<string, readonly string[]>,
): string {
  const selectedNodeIds = nodes
    .filter((node) => node.selected)
    .map((node) => node.id)
    .sort();
  const selectedStrokes = Object.entries(copyStrokeSelection(selection))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([nodeId, strokeIds]) => [nodeId, [...strokeIds].sort()]);
  return JSON.stringify([canvasId, selectedNodeIds, selectedStrokes]);
}

export function inkStrokeSelectionIdentity(
  canvasId: string,
  selection: Record<string, readonly string[]>,
): string {
  const selectedStrokes = Object.entries(copyStrokeSelection(selection))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([nodeId, strokeIds]) => [nodeId, [...strokeIds].sort()]);
  return JSON.stringify([canvasId, selectedStrokes]);
}

export function inkLassoIdentity(
  canvasId: string,
  selection: Record<string, readonly string[]>,
  polygon: readonly { x: number; y: number }[] | null,
): string {
  return JSON.stringify([
    inkStrokeSelectionIdentity(canvasId, selection),
    polygon?.map((point) => [point.x, point.y]) ?? null,
  ]);
}

export function unionSelectionBounds(
  left: { x: number; y: number; width: number; height: number } | null,
  right: { x: number; y: number; width: number; height: number } | null,
): { x: number; y: number; width: number; height: number } | null {
  if (!left) return right;
  if (!right) return left;
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

export function retainedLassoBounds(
  polygon: readonly { x: number; y: number }[] | null,
  move: { dx: number; dy: number } | null = null,
): { x: number; y: number; width: number; height: number } | null {
  if (!polygon || polygon.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const dx = move?.dx ?? 0;
  const dy = move?.dy ?? 0;
  return {
    x: minX + dx,
    y: minY + dy,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function groundingOperandsFromContext(context: AgentChatContext): {
  selectedNodeIds: string[];
  strokeSubsets: Array<{ nodeId: string; strokeIds: string[] }>;
} {
  const selectedNodeIds: string[] = [];
  const strokeSubsets: Array<{ nodeId: string; strokeIds: string[] }> = [];
  const collect = (
    nodes: AgentChatContext['selectedNodes'],
    topLevel: boolean,
  ): void => {
    for (const node of nodes) {
      if (node.type === 'sketch' && node.strokeIds?.length) {
        strokeSubsets.push({ nodeId: node.id, strokeIds: [...node.strokeIds] });
      } else if (topLevel && node.type !== 'question') {
        selectedNodeIds.push(node.id);
      }
      if (node.children?.length) collect(node.children, false);
    }
  };
  collect(context.selectedNodes, true);
  return { selectedNodeIds, strokeSubsets };
}
