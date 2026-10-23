// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isDeepStrictEqual } from 'node:util';

import { subscribeCanvasUpdates } from '../canvas/canvas-sync.js';

import type {
  CanvasEdge,
  CanvasNode,
  Delta,
} from '@huabu/shared/canvas-engine';

export class InkAgentModeError extends Error {
  readonly code = 'ink_agent_read_only';

  constructor() {
    super(
      'Ink queries require a Canvas-writing Agent. Choose Agent instead of Chat.',
    );
    this.name = 'InkAgentModeError';
  }
}

export interface InkResponseOutcome {
  error?: string;
  interrupted: boolean;
}

function visibleFields(node: CanvasNode) {
  return {
    type: node.type,
    position: node.position,
    style: node.style,
    parentId: node.parentId,
    hidden: node.hidden,
    data: Object.fromEntries(
      Object.entries(node.data).filter(
        ([key]) =>
          [
            'content',
            'src',
            'strokes',
            'interactiveView',
            'label',
            'style',
          ].includes(key) && !(key === 'label' && node.type === 'question'),
      ),
    ),
  };
}

function visibleEdgeFields(edge: CanvasEdge) {
  return {
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    hidden: edge.hidden,
    style: edge.style,
    label: edge.label,
    type: edge.type,
    data: Object.fromEntries(
      Object.entries(edge.data ?? {}).filter(([key]) =>
        [
          'lineType',
          'lineStyle',
          'stroke',
          'strokeWidth',
          'direction',
          'label',
        ].includes(key),
      ),
    ),
  };
}

export function isInkCanvasResult(delta: Delta): boolean {
  switch (delta.type) {
    case 'INSERT_NODE':
      return !delta.node.hidden && delta.node.type !== 'question';
    case 'DELETE_NODE':
      return !delta.node.hidden;
    case 'REPLACE_NODE':
      return (
        !(delta.prev.hidden && delta.next.hidden) &&
        !isDeepStrictEqual(visibleFields(delta.prev), visibleFields(delta.next))
      );
    case 'INSERT_EDGE':
    case 'DELETE_EDGE':
      return !delta.edge.hidden;
    case 'REPLACE_EDGE':
      return (
        !(delta.prev.hidden && delta.next.hidden) &&
        !isDeepStrictEqual(
          visibleEdgeFields(delta.prev),
          visibleEdgeFields(delta.next),
        )
      );
  }
}

/** Verifies committed, thread-attributed replies without manufacturing one. */
export function createInkResponse(canvasId: string, threadId: string) {
  let visible = false;
  const stop = subscribeCanvasUpdates(canvasId, (event) => {
    if (
      event.type === 'update' &&
      event.data.threadId === threadId &&
      !event.data.agentNodeProjection &&
      (event.data.deltas as Delta[]).some(isInkCanvasResult)
    )
      visible = true;
  });

  return {
    stop,
    async deliver(outcome: InkResponseOutcome): Promise<void> {
      stop();
      // Preserve the original error/cancellation; never replace it with a reply.
      if (outcome.error || outcome.interrupted) return;
      if (!visible)
        throw new Error(
          'The Agent finished without a visible Canvas result. Ink replies must be written to Canvas by the Agent.',
        );
    },
  };
}
