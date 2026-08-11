// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { stripNodeContentForStructurePut } from '../structureNodePayload';

import type { Node } from '@xyflow/react';

const node: Node = {
  id: 'node-1',
  type: 'note',
  position: { x: 12, y: 34 },
  data: {
    content: 'hello',
    label: 'Greeting',
    labelSource: 'user',
    summary: 'summary',
    keywords: ['welcome'],
    provenance: { source: 'test' },
    layoutHint: 'keep-structural-data',
  },
};

describe('structure node payload', () => {
  it('strips sidecar fields from a previously committed node', () => {
    const [slim] = stripNodeContentForStructurePut([node]);

    expect(slim).toMatchObject({
      id: 'node-1',
      position: { x: 12, y: 34 },
      data: { layoutHint: 'keep-structural-data' },
    });
    expect(slim?.data).not.toHaveProperty('content');
    expect(slim?.data).not.toHaveProperty('label');
  });

  it('keeps initial sidecar fields on a queue-tracked aggregate create', () => {
    const [aggregate] = stripNodeContentForStructurePut(
      [node],
      new Set(['node-1']),
    );

    expect(aggregate).toBe(node);
    expect(aggregate?.data).toMatchObject({
      content: 'hello',
      label: 'Greeting',
      labelSource: 'user',
      summary: 'summary',
      keywords: ['welcome'],
      provenance: { source: 'test' },
      layoutHint: 'keep-structural-data',
    });
  });
});
