/**
 * Synthesize a ChatMessage[] timeline for an annotation cluster.
 *
 * Annotation recognition does NOT go through the multi-step agent runner —
 * the rule engine is local and the LLM fallback is a single vision call —
 * so there is no "real" chat thread to replay. Instead we fake one by
 * emitting:
 *
 *  1. A user message describing the gesture (shape + spatial context).
 *  2. An assistant message with the resolver's reasoning.
 *  3. A `canvas_commands` tool message carrying the produced commands +
 *     captured CanvasChange entries — rendered by the existing
 *     `CanvasCommandCard` so Accept / Revert / Blend "just work".
 *  4. A status message if the LLM call failed.
 *
 * The chat panel reads these synthesized messages directly from the
 * intent store; nothing is persisted to the chat thread.
 */

import { useMemo } from 'react';

import { useIntentStore } from '@/store/intentStore';

import type { ChatMessage } from '../../Messages/types';
import type { AnnotationProcessingCluster } from '@/store/intentStore';

const TOOL_TITLE: Record<
  NonNullable<AnnotationProcessingCluster['source']>,
  string
> = {
  rule: 'Resolved by deterministic rules',
  llm: 'Resolved by vision LLM',
};

/**
 * Build the ChatMessage[] timeline for the given cluster.
 * Returns an empty array if the cluster no longer exists.
 */
export function useAnnotationClusterMessages(
  clusterId: string | null,
): ChatMessage[] {
  const cluster = useIntentStore((s) =>
    clusterId ? s.processingClusters.find((c) => c.id === clusterId) : null,
  );

  return useMemo(() => {
    if (!cluster) return [];
    return buildMessages(cluster);
  }, [cluster]);
}

function buildMessages(cluster: AnnotationProcessingCluster): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // 1. User message: describe the gesture
  const shapeLabel = cluster.shape
    ? `${cluster.shape.type} (confidence ${cluster.shape.confidence.toFixed(2)})`
    : 'gesture';
  const userParts: string[] = [
    `Annotation gesture · ${shapeLabel} · ${cluster.strokeIds.length} stroke${cluster.strokeIds.length === 1 ? '' : 's'}`,
  ];
  if (cluster.contextSummary) {
    userParts.push('', cluster.contextSummary);
  }
  messages.push({
    id: `${cluster.id}-user`,
    role: 'user',
    content: userParts.join('\n'),
  });

  // 2. Assistant reasoning (only if we have one)
  if (cluster.reasoning) {
    const sourceTag = cluster.source
      ? `[${TOOL_TITLE[cluster.source]}]\n\n`
      : '';
    messages.push({
      id: `${cluster.id}-assistant`,
      role: 'assistant',
      content: `${sourceTag}${cluster.reasoning}`,
    });
  }

  // 3. canvas_commands tool message — fakes the same shape that
  //    `CanvasCommandCard` consumes from real agent tool output.
  if (
    (cluster.commands?.length ?? 0) > 0 ||
    (cluster.changes?.length ?? 0) > 0
  ) {
    messages.push({
      id: `${cluster.id}-tool`,
      role: 'tool',
      toolResponse: {
        tool: 'canvas_commands',
        status: 'success',
        data: {
          source: cluster.source === 'llm' ? 'agent' : 'rule',
          canvasId: cluster.canvasId,
          commands: cluster.commands ?? [],
          canvasChanges: cluster.changes ?? [],
        },
      },
    });
  }

  // 4. Error
  if (cluster.error) {
    messages.push({
      id: `${cluster.id}-error`,
      role: 'status',
      status: 'error',
      detail: cluster.error,
    });
  }

  return messages;
}
