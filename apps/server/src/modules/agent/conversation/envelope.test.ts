// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const readMany = vi.hoisted(() => vi.fn());

vi.mock('../../storage/index.js', () => ({
  space: () => ({
    nodes: {
      readMany,
      read: vi.fn(),
    },
  }),
}));

import { buildChatEnvelope } from './envelope.js';

import type { NodeContent, NodeSnapshot } from '../../storage/index.js';
import type { FastifyBaseLogger } from 'fastify';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

function snapshot(nodeId: string, content: string): NodeSnapshot {
  return {
    record: {
      nodeId,
      type: 'note',
      label: `Label ${nodeId}`,
      content,
    } as NodeContent,
    revision: `revision-${nodeId}`,
  };
}

describe('buildChatEnvelope selection records', () => {
  beforeEach(() => {
    readMany.mockReset();
    readMany.mockImplementation(async (nodeIds: readonly string[]) => {
      const available = new Map<string, NodeSnapshot>([
        ['frame-1', snapshot('frame-1', 'Frame body')],
        ['child-1', snapshot('child-1', 'Child body')],
      ]);
      return new Map(
        nodeIds.flatMap((nodeId) => {
          const record = available.get(nodeId);
          return record ? [[nodeId, record] as const] : [];
        }),
      );
    });
  });

  it('enriches recursively included frame children from their records', async () => {
    const envelope = await buildChatEnvelope({
      content: 'Review this frame',
      attachments: [],
      selectedNodes: [
        {
          id: 'frame-1',
          type: 'frame',
          children: [{ id: 'child-1', type: 'note' }],
        },
      ],
      canvasId: 'canvas-1',
      logger,
    });

    expect(readMany).toHaveBeenCalledWith(['frame-1', 'child-1']);
    expect(envelope.focus.selection.refs).toEqual([
      expect.objectContaining({ id: 'frame-1', preview: 'Frame body' }),
      expect.objectContaining({ id: 'child-1', preview: 'Child body' }),
    ]);
    expect(envelope.focus.selection.selectedIds).toEqual(['frame-1']);
  });
});
