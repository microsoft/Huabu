// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const extractMock = vi.hoisted(() => vi.fn());

vi.mock('./stages/extract.js', () => ({ extract: extractMock }));

import { runPipeline } from './pipeline.js';

import type { ProviderManager } from './provider-manager.js';
import type { CanvasStore } from '../storage/canvas-store.js';
import type { BlobScope } from '../storage/index.js';
import type { PreprocessNodeRequest } from '@huabu/shared';

const request: PreprocessNodeRequest = {
  canvasId: 'canvas-test',
  nodeId: 'node-test',
  nodeType: 'pdf',
  trigger: 'node_inserted',
  snapshot: { src: 'document.pdf' },
};

function deps(release: () => Promise<void>) {
  const materialize = vi.fn().mockResolvedValue({
    path: '/tmp/materialized-document.pdf',
    release,
  });
  return {
    materialize,
    value: {
      store: {
        canvasId: request.canvasId,
        readNode: () => null,
      } as unknown as CanvasStore,
      blobs: { materialize } as unknown as BlobScope,
      provider: {} as ProviderManager,
    },
  };
}

beforeEach(() => {
  extractMock.mockReset();
});

describe('runPipeline artifact lease lifecycle', () => {
  it('passes the materialized path to extraction and releases after success', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const harness = deps(release);
    extractMock.mockResolvedValue({ content: 'extracted text' });

    const result = await runPipeline(
      request,
      ['resolve_input', 'extract_text', 'build_patch'],
      'pdf',
      'derived',
      harness.value,
    );

    expect(harness.materialize).toHaveBeenCalledWith('document.pdf');
    expect(extractMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/materialized-document.pdf' }),
    );
    expect(result.success).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the lease when extraction fails', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const harness = deps(release);
    extractMock.mockRejectedValue(new Error('extract failed'));

    const result = await runPipeline(
      request,
      ['resolve_input', 'extract_text', 'build_patch'],
      'pdf',
      'derived',
      harness.value,
    );

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EXTRACT_FAILED', level: 'error' }),
      ]),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
