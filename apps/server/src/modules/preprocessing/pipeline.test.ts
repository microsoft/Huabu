// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const extractMock = vi.hoisted(() => vi.fn());
const nameQuestion = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../agent/conversation-title.service.js', () => ({
  conversationTitleService: { initializeQuestion: nameQuestion },
}));

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
  const generateContentMeta = vi.fn();
  return {
    materialize,
    put,
    generateContentMeta,
    value: {
      nodes: {
        canvasId: request.canvasId,
        read: async () => null,
      } as unknown as SpaceNodes,
      artifacts: { materialize, put } as unknown as BlobScope,
      provider: { generateContentMeta } as unknown as ProviderManager,
    },
  };
}

beforeEach(() => {
  extractMock.mockReset();
  nameQuestion.mockClear();
});

describe('Question title delegation', () => {
  it('delegates naming without calling the pipeline provider or returning a label patch', async () => {
    const harness = deps(vi.fn());
    harness.generateContentMeta.mockResolvedValue({ label: 'Generated title' });
    const result = await runPipeline(
      {
        ...request,
        nodeType: 'question',
        snapshot: {
          content: 'First user prompt',
          title: 'Existing automatic label',
          labelSource: 'auto',
        },
      },
      ['resolve_input', 'generate_label', 'build_patch'],
      undefined,
      undefined,
      harness.value,
    );
    expect(nameQuestion).toHaveBeenCalledExactlyOnceWith(
      'canvas-test',
      'node-test',
      'First user prompt',
      true,
    );
    expect(harness.generateContentMeta).not.toHaveBeenCalled();
    expect(result.enriched).toBeUndefined();
    expect(result.patch).toEqual({});
    expect(result.success).toBe(true);
  });

  it.each(['user', 'agent'])(
    'protects a %s label even when enrichment is forced',
    async (labelSource) => {
      const harness = deps(vi.fn());
      harness.generateContentMeta.mockResolvedValue({
        label: 'Generated title',
      });
      const result = await runPipeline(
        {
          ...request,
          nodeType: 'question',
          snapshot: {
            content: 'First user prompt',
            title: 'Protected label',
            labelSource,
          },
          options: { force: true },
        },
        ['resolve_input', 'generate_label', 'build_patch'],
        undefined,
        undefined,
        harness.value,
      );
      expect(harness.generateContentMeta).not.toHaveBeenCalled();
      expect(nameQuestion).toHaveBeenCalledOnce();
      expect(result.enriched).toBeUndefined();
      expect(result.patch).not.toHaveProperty('label');
      expect(result.patch).not.toHaveProperty('labelSource');
      expect(result.success).toBe(true);
    },
  );

  it('does not call the provider when allowLLM is false', async () => {
    const harness = deps(vi.fn());
    await runPipeline(
      {
        ...request,
        nodeType: 'question',
        snapshot: { content: 'First prompt' },
        options: { allowLLM: false },
      },
      ['resolve_input', 'generate_label', 'build_patch'],
      undefined,
      undefined,
      harness.value,
    );
    expect(harness.generateContentMeta).not.toHaveBeenCalled();
    expect(nameQuestion).toHaveBeenCalledWith(
      'canvas-test',
      'node-test',
      'First prompt',
      false,
    );
  });

  it('never adds a second fallback when the naming service returns no metadata', async () => {
    const harness = deps(vi.fn());
    harness.generateContentMeta.mockResolvedValue(undefined);
    const result = await runPipeline(
      {
        ...request,
        nodeType: 'question',
        snapshot: { content: 'First user prompt' },
      },
      ['resolve_input', 'generate_label', 'build_patch'],
      undefined,
      undefined,
      harness.value,
    );
    expect(harness.generateContentMeta).not.toHaveBeenCalled();
    expect(result.enriched).toBeUndefined();
    expect(result.patch).toEqual({});
    expect(result.success).toBe(true);
  });
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
