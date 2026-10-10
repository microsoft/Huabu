// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isDeepStrictEqual } from 'node:util';

import { createId, type CanvasCommand, type CanvasNodeId } from '@huabu/shared';
import {
  computeAdjacentNodePlacement,
  getAbsolutePosition,
  getNodeDefaultSize,
  getNodeSize,
  type CanvasNode,
  type Delta,
} from '@huabu/shared/canvas-engine';

import { executeOnServerAlreadyLocked } from '../canvas/canvas-executor.js';
import { subscribeCanvasUpdates } from '../canvas/canvas-sync.js';
import { space, withCanvasMutex } from '../storage/index.js';

export interface InkResponseOutcome {
  text: string;
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
          ['content', 'src', 'strokes', 'interactiveView', 'label'].includes(
            key,
          ) && !(key === 'label' && node.type === 'question'),
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
    default:
      return true;
  }
}

/** Watches committed, thread-attributed writes; it does not grant Agent tools. */
export function createInkResponse(canvasId: string, threadId: string) {
  const noteId = createId('node');
  let visible = false;
  let delivered = false;
  let pending: Promise<void> | undefined;
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
    deliver(outcome: InkResponseOutcome): Promise<void> {
      stop();
      if (delivered || (visible && !outcome.error && !outcome.interrupted))
        return Promise.resolve();
      if (pending) return pending;
      pending = withCanvasMutex(canvasId, async () => {
        const canvas = await space(canvasId).read();
        if (!canvas)
          throw new Error(
            'Cannot deliver Ink response: Canvas no longer exists',
          );
        const nodes = canvas.state.nodes as CanvasNode[];
        if (nodes.some((node) => node.id === noteId)) {
          delivered = true;
          return;
        }
        const owner = nodes.find(
          (node) => node.type === 'question' && node.data.threadId === threadId,
        );
        const anchor = owner ?? nodes.find((node) => node.type === 'sketch');
        const position = anchor
          ? (getAbsolutePosition(nodes, anchor.id) ?? anchor.position)
          : { x: 0, y: 0 };
        const size = anchor
          ? getNodeSize(anchor)
          : getNodeDefaultSize('question');
        const text = outcome.text.trim();
        const notice = outcome.error
          ? `Ink request failed: ${outcome.error}`
          : outcome.interrupted
            ? 'Ink request interrupted. The response may be incomplete.'
            : !text
              ? 'The Agent finished without providing an answer or a Canvas result.'
              : '';
        const content = [notice, text].filter(Boolean).join('\n\n');
        const commands: CanvasCommand[] = [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: noteId,
                nodeType: 'note',
                position: computeAdjacentNodePlacement({
                  nodes,
                  source: {
                    ...position,
                    width: size.width,
                    height: size.height ?? 100,
                  },
                  nodeType: 'note',
                  side: 'bottom',
                }),
                data: {
                  label: 'Ink response',
                  content,
                  origin: { type: 'user-from-chat', threadId },
                },
              },
            ],
          },
        ];
        if (owner)
          commands.push({
            type: 'CONNECT_NODES',
            edges: [{ source: owner.id as CanvasNodeId, target: noteId }],
          });
        const result = await executeOnServerAlreadyLocked({
          canvasId,
          commands,
          originator: { source: 'system', threadId },
        });
        if (!result.results.every((item) => item.applied))
          throw new Error('Ink response could not be delivered to Canvas');
        delivered = true;
      }).finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
