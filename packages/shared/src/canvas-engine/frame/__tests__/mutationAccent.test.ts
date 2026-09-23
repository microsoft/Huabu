// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { frameNodes, frameNodesInRect } from '../mutation.js';

describe('Frame creation accent', () => {
  it('persists white when grouping existing nodes', () => {
    const result = frameNodes(
      [
        {
          id: 'note',
          type: 'note',
          position: { x: 20, y: 30 },
          data: {},
          style: { width: 200, height: 120 },
        },
      ],
      ['note'],
      { frameId: 'frame' },
    );

    expect(
      result.nodes.find((node) => node.id === 'frame')?.data,
    ).toMatchObject({
      style: { accent: 'white' },
    });
  });

  it('persists white when drawing a Frame rectangle', () => {
    const result = frameNodesInRect(
      [],
      { x: 10, y: 20, width: 600, height: 400 },
      'frame',
    );

    expect(
      result.nodes.find((node) => node.id === 'frame')?.data,
    ).toMatchObject({
      style: { accent: 'white' },
    });
  });
});
