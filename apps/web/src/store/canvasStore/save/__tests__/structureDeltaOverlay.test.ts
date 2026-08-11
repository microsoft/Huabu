// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { overlayLocalFieldsOnStructureDeltas } from '../structureDeltaOverlay';

import type { Delta } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

describe('structure delta overlay', () => {
  it('keeps omitted sidecar/runtime fields while accepting new topology', () => {
    const current: Node = {
      id: 'node-1',
      type: 'note',
      position: { x: 1, y: 2 },
      selected: true,
      measured: { width: 120, height: 80 },
      data: {
        content: 'local body',
        label: 'Local label',
        contentMissing: false,
        structuralHint: 'old',
      },
    };
    const delta = {
      type: 'REPLACE_NODE',
      previous: current,
      next: {
        id: 'node-1',
        type: 'note',
        position: { x: 50, y: 60 },
        data: { structuralHint: 'new' },
      },
    } as unknown as Delta;

    const [overlaid] = overlayLocalFieldsOnStructureDeltas([delta], [current]);
    expect(overlaid).toMatchObject({
      type: 'REPLACE_NODE',
      next: {
        position: { x: 50, y: 60 },
        selected: true,
        measured: { width: 120, height: 80 },
        data: {
          content: 'local body',
          label: 'Local label',
          contentMissing: false,
          structuralHint: 'new',
        },
      },
    });
  });
});
