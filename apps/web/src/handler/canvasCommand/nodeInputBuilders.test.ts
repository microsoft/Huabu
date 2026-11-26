// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  uploadAudio,
  uploadHtml,
  uploadOffice,
  uploadPdf,
} from '@/api/artifact';
import { toast } from '@/components/Common/Toast';
import { useImportPlaceholderStore } from '@/store/importPlaceholderStore';
import { pageLifecycle } from '@/utils/pageLifecycle';

import { importFilesAsNodes } from './nodeInputBuilders';

vi.mock('@/api/artifact', () => ({
  uploadAudio: vi.fn(),
  uploadPdf: vi.fn(),
  uploadImage: vi.fn(),
  uploadVideo: vi.fn(),
  uploadOffice: vi.fn(),
  uploadHtml: vi.fn(),
}));
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useImportPlaceholderStore.setState({ placeholders: [] });
});

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

  it.each([
    ['song.mp3', 'audio/mpeg'],
    ['song.mp3', ''],
    ['song#1.mp3', ''],
  ])('imports %s (type "%s") as an audio node', async (name, type) => {
    vi.mocked(uploadAudio).mockResolvedValueOnce('artifact.mp3');
    const addNodes = vi.fn();
    await importFilesAsNodes(
      [new File(['audio'], name, { type })],
      { x: 0, y: 0 },
      { type: 'user-uploaded' },
      'space',
      addNodes,
    );
    expect(addNodes).toHaveBeenCalledWith([
      expect.objectContaining({
        nodeType: 'audio',
        data: expect.objectContaining({ src: 'artifact.mp3', label: name }),
      }),
    ]);
    expect(uploadHtml).not.toHaveBeenCalled();
  });

  it('imports an html file whose name contains # as a web node', async () => {
    vi.mocked(uploadHtml).mockResolvedValueOnce('artifact.html');
    const addNodes = vi.fn();
    await importFilesAsNodes(
      [new File(['page'], 'page#1.html', { type: '' })],
      undefined,
      { type: 'user-uploaded' },
      'space',
      addNodes,
    );
    expect(addNodes).toHaveBeenCalledWith([
      expect.objectContaining({ nodeType: 'web' }),
    ]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('reads the Office format from a file name that contains #', async () => {
    vi.mocked(uploadOffice).mockResolvedValueOnce('artifact.xlsx');
    const addNodes = vi.fn();
    await importFilesAsNodes(
      [new File(['sheet'], 'sheet#1.xlsx', { type: '' })],
      undefined,
      { type: 'user-uploaded' },
      'space',
      addNodes,
    );
    expect(addNodes).toHaveBeenCalledWith([
      expect.objectContaining({
        nodeType: 'office',
        data: expect.objectContaining({ format: 'xlsx' }),
      }),
    ]);
  });

  it('names the files it cannot import and still imports the rest', async () => {
    vi.mocked(uploadPdf).mockResolvedValueOnce('artifact.pdf');
    const addNodes = vi.fn();
    await importFilesAsNodes(
      [
        new File(['zip'], 'archive.zip', { type: 'application/zip' }),
        new File(['page'], 'saved.mhtml', { type: 'message/rfc822' }),
        new File(['pdf'], 'document.pdf', { type: 'application/pdf' }),
      ],
      undefined,
      { type: 'user-uploaded' },
      'space',
      addNodes,
    );
    expect(addNodes).toHaveBeenCalledWith([
      expect.objectContaining({ nodeType: 'pdf' }),
    ]);
    expect(uploadHtml).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining('archive.zip, saved.mhtml'),
      {
        tone: 'danger',
      },
    );
  });

  it('shows a card at the drop point until the node replaces it', async () => {
    let uploaded!: (value: string) => void;
    vi.mocked(uploadPdf).mockReturnValueOnce(
      new Promise((resolve) => {
        uploaded = resolve;
      }),
    );
    const cards = () => useImportPlaceholderStore.getState().placeholders;
    const addNodes = vi.fn(() => {
      // The card is still there when the node is inserted, so the swap
      // happens in one render.
      expect(cards()).toHaveLength(1);
    });
    const importing = importFilesAsNodes(
      [new File(['pdf'], 'document.pdf', { type: 'application/pdf' })],
      { x: 10, y: 20 },
      { type: 'user-uploaded' },
      'space',
      addNodes,
    );
    expect(cards()).toEqual([
      expect.objectContaining({
        canvasId: 'space',
        nodeType: 'pdf',
        name: 'document.pdf',
        x: 10,
        y: 20,
        width: 400,
        height: 400,
      }),
    ]);
    expect(cards()[0].error).toBeUndefined();
    uploaded('artifact.pdf');
    await importing;
    expect(addNodes).toHaveBeenCalledTimes(1);
    expect(cards()).toEqual([]);
  });

  it('keeps a failed card and imports the file again on retry', async () => {
    vi.mocked(uploadPdf)
      .mockRejectedValueOnce(new Error('Upload offline'))
      .mockResolvedValueOnce('artifact.pdf');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cards = () => useImportPlaceholderStore.getState().placeholders;
    const addNodes = vi.fn();
    await importFilesAsNodes(
      [new File(['pdf'], 'document.pdf', { type: 'application/pdf' })],
      { x: 10, y: 20 },
      { type: 'user-uploaded' },
      'space',
      addNodes,
    );
    expect(addNodes).not.toHaveBeenCalled();
    expect(cards()).toEqual([
      expect.objectContaining({
        name: 'document.pdf',
        error: 'Upload offline',
      }),
    ]);

    // The card carries the failure, so no toast repeats it.
    expect(toast).not.toHaveBeenCalled();

    cards()[0].retry?.();
    expect(cards()).toEqual([
      expect.objectContaining({ name: 'document.pdf', x: 10, y: 20 }),
    ]);
    expect(cards()[0].error).toBeUndefined();
    await vi.waitFor(() => expect(cards()).toEqual([]));
    expect(addNodes).toHaveBeenCalledWith([
      expect.objectContaining({
        nodeType: 'pdf',
        placementPoint: { x: 10, y: 20 },
        data: expect.objectContaining({ src: 'artifact.pdf' }),
      }),
    ]);
  });

  it('shows no card for a file it cannot import or for a note', async () => {
    const addNodes = vi.fn();
    await importFilesAsNodes(
      [
        new File(['zip'], 'archive.zip', { type: 'application/zip' }),
        new File(['# Title'], 'readme.md', { type: 'text/markdown' }),
      ],
      { x: 0, y: 0 },
      { type: 'user-uploaded' },
      'space',
      addNodes,
    );
    expect(addNodes).toHaveBeenCalledWith([
      expect.objectContaining({ nodeType: 'note' }),
    ]);
    expect(useImportPlaceholderStore.getState().placeholders).toEqual([]);
  });
});
