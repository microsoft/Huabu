// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMilkdown,
  extractImageFiles,
  fileNameToAlt,
  type MilkdownInstance,
} from '../createMilkdown';

let instances: MilkdownInstance[] = [];
let roots: HTMLElement[] = [];

async function mount(
  markdown: string,
  resolveImageSrc?: (src: string) => string,
  importImage?: (image: {
    src: string;
    srcCanvasId?: string;
  }) => Promise<string>,
): Promise<{ instance: MilkdownInstance; root: HTMLElement }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  const instance = await createMilkdown({
    root,
    initialMarkdown: markdown,
    toolbarMode: 'none',
    resolveImageSrc,
    importImage,
  });
  instances.push(instance);
  return { instance, root };
}

/** Minimal DataTransfer stand-in carrying a `files` list. */
function dataTransferWith(files: File[]): DataTransfer {
  return { files } as unknown as DataTransfer;
}

/** DataTransfer stand-in that exposes images only via `items` (no `files`). */
function dataTransferWithItems(files: File[]): DataTransfer {
  return {
    files: [] as unknown as FileList,
    items: files.map((file) => ({
      kind: 'file' as const,
      type: file.type,
      getAsFile: () => file,
    })),
  } as unknown as DataTransfer;
}

afterEach(async () => {
  await Promise.all(instances.map((instance) => instance.destroy()));
  for (const root of roots) root.remove();
  instances = [];
  roots = [];
});

describe('extractImageFiles', () => {
  it('returns an empty array for a null transfer', () => {
    expect(extractImageFiles(null)).toEqual([]);
    expect(extractImageFiles(undefined)).toEqual([]);
  });

  it('keeps only image/* files', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const txt = new File(['x'], 'note.txt', { type: 'text/plain' });
    const gif = new File(['x'], 'b.gif', { type: 'image/gif' });
    const result = extractImageFiles(dataTransferWith([png, txt, gif]));
    expect(result).toEqual([png, gif]);
  });

  it('returns empty when no image files are present', () => {
    const txt = new File(['x'], 'note.txt', { type: 'text/plain' });
    expect(extractImageFiles(dataTransferWith([txt]))).toEqual([]);
  });

  it('falls back to items when files is empty', () => {
    const png = new File(['x'], 'pasted.png', { type: 'image/png' });
    expect(extractImageFiles(dataTransferWithItems([png]))).toEqual([png]);
  });

  it('does not double-count an image present in both files and items', () => {
    const png = new File(['x'], 'shot.png', { type: 'image/png' });
    const dt = {
      files: [png],
      items: [{ kind: 'file' as const, type: png.type, getAsFile: () => png }],
    } as unknown as DataTransfer;
    expect(extractImageFiles(dt)).toEqual([png]);
  });
});

describe('fileNameToAlt', () => {
  it('strips a single trailing extension', () => {
    expect(fileNameToAlt('screenshot.png')).toBe('screenshot');
    expect(fileNameToAlt('my.photo.jpeg')).toBe('my.photo');
  });

  it('leaves extensionless names untouched and trims', () => {
    expect(fileNameToAlt('  pasted  ')).toBe('pasted');
    expect(fileNameToAlt('image')).toBe('image');
  });
});

describe('image src resolution (nodeView)', () => {
  it('keeps the bare artifact key in the serialized markdown', async () => {
    const { instance } = await mount('![alt text](art_abc.png)');
    // The document / onChange payload must persist the canonical bare
    // key — never the resolved display URL.
    expect(instance.getMarkdown()).toContain('art_abc.png');
    expect(instance.getMarkdown()).toContain('![alt text](art_abc.png)');
  });

  it('resolves the rendered <img> src for display without mutating the doc', async () => {
    const { instance, root } = await mount(
      '![alt text](art_abc.png)',
      (src) => `https://cdn.test/${src}`,
    );

    const img = root.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://cdn.test/art_abc.png');
    expect(img?.getAttribute('alt')).toBe('alt text');

    // Serialized markdown still carries the bare key, proving the
    // resolution happens only at the DOM boundary.
    expect(instance.getMarkdown()).toContain('art_abc.png');
    expect(instance.getMarkdown()).not.toContain('https://cdn.test');
  });

  it('resolves a direct image drag as a removable note block', async () => {
    const { instance, root } = await mount(
      'before\n\n![alt text](art_abc.png)\n\nafter',
    );

    const img = root.querySelector('img');
    expect(img).not.toBeNull();

    const range = instance.getDragRangeAtDOM(img as HTMLImageElement);
    const payload = instance.getDragPayload(range);

    expect(payload?.markdown).toContain('![alt text](art_abc.png)');
    const sourceContentAfterMove = instance.getDocAfterRangeRemoved(
      payload?.range ?? null,
    );
    expect(sourceContentAfterMove).toContain('before');
    expect(sourceContentAfterMove).toContain('after');
    expect(sourceContentAfterMove).not.toContain('art_abc.png');
  });

  it('pastes a copied canvas image as an image block instead of JSON', async () => {
    const importImage = vi.fn(async () => 'artifact-cloned.png');
    const { instance, root } = await mount('', undefined, importImage);
    const clipboardData = new DataTransfer();
    clipboardData.setData(
      'text/plain',
      JSON.stringify({
        __huabu_nodes__: [
          {
            id: 'node-image',
            type: 'image',
            data: {
              type: 'image',
              src: 'artifact-source.png',
              label: 'Huabu collaboration banner',
            },
          },
        ],
        __huabu_edges__: [],
        __huabu_canvas_id__: 'canvas-source',
      }),
    );

    root.querySelector('.ProseMirror')?.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );

    await vi.waitFor(() => {
      expect(instance.getMarkdown()).toContain(
        '![Huabu collaboration banner](artifact-cloned.png)',
      );
    });
    expect(instance.getMarkdown()).not.toContain('__huabu_nodes__');
    expect(importImage).toHaveBeenCalledWith({
      src: 'artifact-source.png',
      srcCanvasId: 'canvas-source',
    });
  });
});
