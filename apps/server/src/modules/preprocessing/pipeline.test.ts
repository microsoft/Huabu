// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const extractMock = vi.hoisted(() => vi.fn());

vi.mock('./stages/extract.js', () => ({ extract: extractMock }));

import { runPipeline } from './pipeline.js';

import type { ProviderManager } from './provider-manager.js';
import type { BlobScope, SpaceNodes } from '../storage/index.js';
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
  const put = vi.fn().mockResolvedValue({ name: 'artifact_test.pdf' });
  return {
    materialize,
    put,
    value: {
      nodes: {
        canvasId: request.canvasId,
        read: async () => null,
      } as unknown as SpaceNodes,
      blobs: { materialize, put } as unknown as BlobScope,
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

describe('runPipeline remote PDF snapshot', () => {
  const remoteRequest: PreprocessNodeRequest = {
    ...request,
    snapshot: { src: 'https://arxiv.org/pdf/2505.10831' },
  };

  it('stores freshly fetched PDF bytes as a canvas-local artifact', async () => {
    const harness = deps(vi.fn().mockResolvedValue(undefined));
    const rawPdf = Buffer.from('%PDF-test');
    extractMock.mockResolvedValue({ content: 'paper text', rawPdf });

    await runPipeline(
      remoteRequest,
      ['resolve_input', 'extract_text', 'build_patch'],
      'pdf',
      'derived',
      harness.value,
    );

    expect(harness.put).toHaveBeenCalledWith(
      expect.stringMatching(/^artifact-.+\.pdf$/),
      rawPdf,
    );
  });

  it('keeps preprocessing successful when snapshot storage fails', async () => {
    const harness = deps(vi.fn().mockResolvedValue(undefined));
    harness.put.mockRejectedValue(new Error('blob unavailable'));
    extractMock.mockResolvedValue({
      content: 'paper text',
      rawPdf: Buffer.from('%PDF-test'),
    });

    const result = await runPipeline(
      remoteRequest,
      ['resolve_input', 'extract_text', 'build_patch'],
      'pdf',
      'derived',
      harness.value,
    );

    expect(result.success).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SNAPSHOT_FAILED', level: 'warning' }),
      ]),
    );
  });
});
