// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { tryCacheShortCircuit } from './cache-check.js';

import type { CanvasStore } from '../../storage/index.js';
import type { PipelineContext, PreprocessDiagnostic } from '../types.js';
import type { PreprocessNodeRequest } from '@huabu/shared';

describe('tryCacheShortCircuit remote PDF migration', () => {
  it('does not reuse cached text while src is still a remote PDF URL', () => {
    const src = 'https://arxiv.org/pdf/2505.10831';
    const request: PreprocessNodeRequest = {
      canvasId: 'canvas-test',
      nodeId: 'pdf-1',
      nodeType: 'pdf',
      trigger: 'node_updated',
      snapshot: { src },
    };
    const ctx: PipelineContext = {};
    const diagnostics: PreprocessDiagnostic[] = [];
    const store = {
      readNode: () => ({
        nodeId: 'pdf-1',
        type: 'pdf',
        label: 'Paper',
        src,
        content: 'cached text',
      }),
    } as unknown as CanvasStore;

    expect(
      tryCacheShortCircuit(
        request,
        { nodeId: 'pdf-1', nodeType: 'pdf', artifactUri: src },
        ctx,
        diagnostics,
        store,
      ),
    ).toBe(false);
    expect(diagnostics).toEqual([]);
  });
});
