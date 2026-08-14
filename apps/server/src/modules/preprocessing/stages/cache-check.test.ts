// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { tryCacheShortCircuit } from './cache-check.js';

import type { SpaceNodes } from '../../storage/index.js';
import type { PipelineContext, PreprocessDiagnostic } from '../types.js';
import type { PreprocessNodeRequest } from '@huabu/shared';

describe('tryCacheShortCircuit remote PDF migration', () => {
  it('does not reuse cached text while src is still a remote PDF URL', async () => {
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
    const nodes = {
      canvasId: request.canvasId,
      read: vi.fn(),
    } as unknown as SpaceNodes;

    await expect(
      tryCacheShortCircuit(
        request,
        { nodeId: 'pdf-1', nodeType: 'pdf', artifactUri: src },
        ctx,
        diagnostics,
        nodes,
      ),
    ).resolves.toBe(false);
    expect(diagnostics).toEqual([]);
    expect(nodes.read).not.toHaveBeenCalled();
  });

  it('awaits the node repository and reuses a local PDF artifact', async () => {
    const src = 'artifact-paper.pdf';
    const request: PreprocessNodeRequest = {
      canvasId: 'canvas-test',
      nodeId: 'pdf-1',
      nodeType: 'pdf',
      trigger: 'node_updated',
      snapshot: { src },
    };
    const ctx: PipelineContext = {};
    const diagnostics: PreprocessDiagnostic[] = [];
    const nodes = {
      canvasId: request.canvasId,
      read: vi.fn().mockResolvedValue({
        record: {
          nodeId: 'pdf-1',
          type: 'pdf',
          label: 'Paper',
          src,
          content: 'cached text',
        },
        revision: 'opaque-revision',
      }),
    } as unknown as SpaceNodes;

    await expect(
      tryCacheShortCircuit(
        request,
        { nodeId: 'pdf-1', nodeType: 'pdf', artifactUri: src },
        ctx,
        diagnostics,
        nodes,
      ),
    ).resolves.toBe(true);
    expect(nodes.read).toHaveBeenCalledWith('pdf-1');
    expect(ctx.normalized?.canonicalContent).toBe('cached text');
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'CACHE_HIT', level: 'info' }),
    ]);
  });

  it('propagates repository read failures instead of reporting a cache miss', async () => {
    const src = 'artifact-paper.pdf';
    const request: PreprocessNodeRequest = {
      canvasId: 'canvas-test',
      nodeId: 'pdf-1',
      nodeType: 'pdf',
      trigger: 'node_updated',
      snapshot: { src },
    };
    const ctx: PipelineContext = {};
    const diagnostics: PreprocessDiagnostic[] = [];
    const readError = new Error('storage backend unavailable');
    const nodes = {
      canvasId: request.canvasId,
      read: vi.fn().mockRejectedValue(readError),
    } as unknown as SpaceNodes;

    await expect(
      tryCacheShortCircuit(
        request,
        { nodeId: 'pdf-1', nodeType: 'pdf', artifactUri: src },
        ctx,
        diagnostics,
        nodes,
      ),
    ).rejects.toBe(readError);
    expect(nodes.read).toHaveBeenCalledWith('pdf-1');
    expect(ctx).toEqual({});
    expect(diagnostics).toEqual([]);
  });
});
