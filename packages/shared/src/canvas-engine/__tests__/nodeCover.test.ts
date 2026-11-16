// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { agentCanvasCommandSchema } from '../../types/api/space-operations.js';
import { executeCanvasCommands } from '../index.js';

import type { CanvasNode } from '../interfaces.js';

const pdf: CanvasNode = {
  id: 'pdf',
  type: 'pdf',
  position: { x: 0, y: 0 },
  data: { label: 'Paper', coverUrl: 'old.png' },
};

function merge(patch: Record<string, unknown>) {
  return executeCanvasCommands(
    {
      source: 'agent',
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'pdf' as never, patch }],
        },
      ],
    },
    { nodes: [pdf], edges: [], canvasId: 'space' },
  ).writeResult.nodes[0].data;
}

it('replaces a cover and removes it on null, leaving other data intact', () => {
  expect(merge({ coverUrl: 'new.png' })).toEqual({
    label: 'Paper',
    coverUrl: 'new.png',
  });
  expect(merge({ coverUrl: null })).toEqual({ label: 'Paper' });
});

it('accepts a string or null cover in the agent command contract', () => {
  const parse = (coverUrl: unknown) =>
    agentCanvasCommandSchema.safeParse({
      type: 'MERGE_NODE_DATA',
      patches: [{ nodeId: 'pdf', patch: { coverUrl } }],
    }).success;
  expect(parse('upload/cover.png')).toBe(true);
  expect(parse(null)).toBe(true);
  expect(parse(42)).toBe(false);
});
