// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadPdf } from '@/api/artifact';
import { toast } from '@/components/Common/Toast';
import { pageLifecycle } from '@/utils/pageLifecycle';

import { importFilesAsNodes } from './nodeInputBuilders';

vi.mock('@/api/artifact', () => ({
  uploadPdf: vi.fn(),
  uploadImage: vi.fn(),
  uploadVideo: vi.fn(),
  uploadOffice: vi.fn(),
  uploadHtml: vi.fn(),
}));
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe('file import lifecycle', () => {
  it('waits for upload and node insertion before the final save', async () => {
    let uploaded!: (value: string) => void;
    vi.mocked(uploadPdf).mockReturnValueOnce(
      new Promise((resolve) => {
        uploaded = resolve;
      }),
    );
    const events: string[] = [];
    const addNodes = vi.fn(() => {
      events.push('insert');
    });
    const unregister = pageLifecycle.register('test-save', {
      flush: async () => {
        events.push('save');
      },
    });
    const importing = importFilesAsNodes(
      [new File(['pdf'], 'document.pdf', { type: 'application/pdf' })],
      { x: 10, y: 20 },
      { type: 'user-uploaded' },
      'space',
      addNodes,
    );
    const close = pageLifecycle.prepare(new AbortController().signal, vi.fn());
    try {
      await Promise.resolve();
      expect(events).toEqual([]);
      uploaded('artifact.pdf');
      await Promise.all([importing, close]);
      expect(events).toEqual(['insert', 'save']);
      expect(addNodes).toHaveBeenCalledWith([
        expect.objectContaining({
          nodeType: 'pdf',
          placementPoint: { x: 10, y: 20 },
          data: expect.objectContaining({
            src: 'artifact.pdf',
            label: 'document.pdf',
          }),
        }),
      ]);
    } finally {
      unregister();
    }
  });

  it('awaits every file, preserves successful insertions, and retains the page on failure', async () => {
    let failed!: (error: Error) => void;
    let uploaded!: (value: string) => void;
    vi.mocked(uploadPdf)
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          failed = reject;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          uploaded = resolve;
        }),
      );
    const addNodes = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const importing = importFilesAsNodes(
      ['bad.pdf', 'good.pdf'].map(
        (name) => new File(['pdf'], name, { type: 'application/pdf' }),
      ),
      undefined,
      { type: 'user-uploaded' },
      'space',
      addNodes,
    );
    let finished = false;
    const close = pageLifecycle.prepare(new AbortController().signal, vi.fn());
    const failure = expect(close)
      .rejects.toThrow('Upload offline')
      .then(() => {
        finished = true;
      });
    await Promise.resolve();
    failed(new Error('Upload offline'));
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(addNodes).not.toHaveBeenCalled();
    uploaded('good-artifact.pdf');
    await Promise.all([importing, failure]);
    expect(addNodes).toHaveBeenCalledWith([
      expect.objectContaining({
        data: expect.objectContaining({ src: 'good-artifact.pdf' }),
      }),
    ]);
    expect(toast).toHaveBeenCalledWith('Upload offline', { tone: 'danger' });
    log.mockRestore();
  });
});
