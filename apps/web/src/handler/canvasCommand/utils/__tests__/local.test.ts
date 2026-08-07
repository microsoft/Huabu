// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { recentActionSchema } from '@huabu/shared';

import { extractNodeRef } from '../local';

import type { Node } from '@xyflow/react';

describe('extractNodeRef', () => {
  it('omits a hydrated null label from the wire reference', () => {
    const node = {
      id: 'node-1',
      type: 'video',
      position: { x: 0, y: 0 },
      data: { label: null },
    } as unknown as Node;

    const ref = extractNodeRef(node);
    expect(ref).toEqual({
      id: 'node-1',
      type: 'video',
      origin: undefined,
    });
    expect(
      recentActionSchema.safeParse({ action: 'node_selected', node: ref })
        .success,
    ).toBe(true);
  });
});
