// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Synthesize a ChatMessage[] timeline for a sketch cluster.
 *
 * Sketch recognition runs as a single server-side vision-LLM call (with
 * on-demand `read` / `inspect_nodes` / `inspect_edges` tool access), so
 * there is no real chat thread to replay. Instead we fake one by emitting:
 *
 *  1. A user message describing the gesture (stroke count + ID context).
 *  2. An assistant message carrying the LLM's reasoning + a synthetic
 *     `space_commands` tool part (rendered by the existing
 *     `SpaceCommandCard` so Accept / Revert / Blend "just work").
 *  3. A status message if the LLM call failed.
 *
 * The chat panel reads these synthesized messages directly from the
 * intent store; nothing is persisted to the chat thread.
 */

import { useMemo } from 'react';

import { useIntentStore } from '@/store/intentStore';

import type { AssistantSegment, ChatMessage } from '@/store/chatTypes';
import type { SketchProcessingCluster } from '@/store/intentStore';

/**
 * Build the ChatMessage[] timeline for the given cluster.
 * Returns an empty array if the cluster no longer exists.
 */
export function useSketchClusterMessages(
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

function buildMessages(cluster: SketchProcessingCluster): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // 1. User message: describe the gesture
  const userParts: string[] = [
    `Sketch gesture · ${cluster.strokeIds.length} stroke${cluster.strokeIds.length === 1 ? '' : 's'}`,
  ];
  if (cluster.contextSummary) {
    userParts.push('', cluster.contextSummary);
  }
  messages.push({
    id: `${cluster.id}-user`,
    role: 'user',
    content: userParts.join('\n'),
  });

  // 2. Assistant message — the recognition reasoning. The canvas mutations
  //    themselves are applied + reviewed server-side (broadcast change
  //    records drive the overlay's Keep / Revert), so there is no synthetic
  //    command card here.
  const segments: AssistantSegment[] = [];
  if (cluster.reasoning) {
    segments.push({ kind: 'text', text: cluster.reasoning });
  }
  if (segments.length > 0) {
    messages.push({
      id: `${cluster.id}-assistant`,
      role: 'assistant',
      segments,
    });
  }

  // 3. Error
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
