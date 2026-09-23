// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NOTE_CONTENT_HOST_STYLE } from '@/components/Nodes/note/noteContentHost';

import {
  destroyOffscreenMeasurer,
  measureNoteHeightOffscreen,
} from '../offscreenMeasurer';

const mocks = vi.hoisted(() => ({
  widths: [] as string[],
  create: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('@/api/artifact', () => ({ resolveArtifactUrl: (src: string) => src }));
vi.mock('@/components/Milkdown/createMilkdown', () => ({
  createMilkdown: async ({ root }: { root: HTMLElement }) => {
    mocks.create();
    const prose = document.createElement('div');
    prose.className = 'ProseMirror';
    Object.defineProperty(prose, 'scrollHeight', {
      get: () => (parseFloat(root.style.width) < 400 ? 300 : 150),
    });
    root.append(prose);
    return {
      setMarkdown: () => mocks.widths.push(root.style.width),
      destroy: mocks.destroy,
    };
  },
}));
vi.mock('../stability', () => ({
  imagesDecoded: () => true,
  awaitStableHeight: async ({ sample }: { sample: () => number }) => ({
    height: sample(),
    provisional: false,
  }),
}));

afterEach(async () => {
  await destroyOffscreenMeasurer();
  mocks.widths.length = 0;
  vi.clearAllMocks();
});

describe('offscreen actual-width measurement', () => {
  it('registers every shared host custom property in the CSS declaration', async () => {
    await measureNoteHeightOffscreen({
      markdown: '# Shared typography',
      contentWidth: 394,
    });

    const host = document.querySelector<HTMLElement>(
      '[data-huabu-height-measurer] > div',
    );
    expect(host).not.toBeNull();
    const customProperties = Object.entries(NOTE_CONTENT_HOST_STYLE).filter(
      ([name]) => name.startsWith('--'),
    );
    expect(customProperties.length).toBeGreaterThan(0);
    for (const [name, value] of customProperties) {
      expect(host?.style.getPropertyValue(name), name).toBe(String(value));
    }
  });

  it('sets each captured width before Markdown, serializing one shared editor', async () => {
    const results = await Promise.all([
      measureNoteHeightOffscreen({
        markdown: 'same document',
        contentWidth: 394,
        canvasId: 'c1',
      }),
      measureNoteHeightOffscreen({
        markdown: 'same document',
        contentWidth: 794,
        canvasId: 'c1',
      }),
      measureNoteHeightOffscreen({
        markdown: 'same document',
        contentWidth: 194,
        canvasId: 'c1',
      }),
    ]);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.widths).toEqual(['394px', '794px', '194px']);
    expect(results[0].height).toBeGreaterThan(results[1].height);
    expect(results[2]).toEqual(results[0]);
    const host = document.querySelector<HTMLElement>(
      '[data-huabu-height-measurer] > div',
    );
    expect(host?.style.paddingInline).toBe('16px');
    expect(host?.style.transform).toBe('');
  });
});
