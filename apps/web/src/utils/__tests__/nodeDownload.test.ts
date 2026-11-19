// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';

import {
  canDownloadMediaSource,
  canDownloadWebSource,
  dataUrlToBlob,
  downloadMediaTarget,
  officeDefaultExtension,
  officeFallbackStem,
  resolveDownloadFilename,
  resolveMediaDownloadTarget,
  resolveWebDownloadTarget,
  triggerMediaDownload,
  triggerNoteDownload,
} from '../io/nodeDownload';

import type * as ApiClientModule from '@/api/_client';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/api/_client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  return {
    ...actual,
    apiFetch: mocks.apiFetch,
    apiUrl: (path: string) => `http://localhost:3001/api${path}`,
  };
});

vi.mock('@/components/Common/Toast', () => ({
  toast: mocks.toast,
}));

describe('nodeDownload', () => {
  let clickedAnchors: Array<{ href: string; download: string }> = [];
  let createdBlobs: Blob[] = [];

  beforeEach(() => {
    clickedAnchors = [];
    createdBlobs = [];
    mocks.apiFetch.mockReset().mockResolvedValue(undefined);
    mocks.toast.mockReset();

    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedAnchors.push({ href: this.href, download: this.download });
    });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(
      (obj: Blob | MediaSource) => {
        if (obj instanceof Blob) createdBlobs.push(obj);
        return `blob:http://localhost/mock-${createdBlobs.length}`;
      },
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolveDownloadFilename', () => {
    it('treats label strictly as an optional stem and enforces canonical extension', () => {
      expect(resolveDownloadFilename('季度报告', '.pdf', 'art_1')).toBe(
        '季度报告.pdf',
      );
      expect(
        resolveDownloadFilename('Architecture Diagram', 'png', 'art_2'),
      ).toBe('Architecture Diagram.png');
      expect(resolveDownloadFilename('v1.2 Release Notes', '.md', 'note')).toBe(
        'v1.2 Release Notes.md',
      );
    });

    it('deduplicates upload-seeded matching and equivalent extensions without double suffixes', () => {
      expect(resolveDownloadFilename('report.PDF', '.pdf', 'art_1')).toBe(
        'report.pdf',
      );
      expect(resolveDownloadFilename('photo.jpeg', '.jpg', 'art_2')).toBe(
        'photo.jpg',
      );
      expect(resolveDownloadFilename('index.htm', '.html', 'page')).toBe(
        'index.html',
      );
      expect(resolveDownloadFilename('README.md', '.md', 'note')).toBe(
        'README.md',
      );
    });

    it('sanitizes illegal filesystem characters, reserved names, and empty labels', () => {
      expect(
        resolveDownloadFilename('Q3/Q4: Forecast*?.xlsx', '.xlsx', 'workbook'),
      ).toBe('Q3_Q4_ Forecast__.xlsx');
      expect(resolveDownloadFilename('CON', '.md', 'note')).toBe('_CON.md');
      expect(resolveDownloadFilename('   ', '.pdf', 'art_fallback')).toBe(
        'art_fallback.pdf',
      );
      expect(resolveDownloadFilename('.pdf', '.pdf', 'art_fallback')).toBe(
        'art_fallback.pdf',
      );
    });
  });

  describe('media & web target resolution', () => {
    it('resolves bare artifact keys, legacy artifact URLs, data URLs, and blob URLs while rejecting external URLs', () => {
      expect(canDownloadMediaSource('art_123.webp')).toBe(true);
      expect(canDownloadMediaSource('art_123.webp', true)).toBe(false);
      expect(canDownloadMediaSource('https://example.com/pic.png')).toBe(false);
      expect(canDownloadMediaSource('https://youtu.be/dQw4w9WgXcQ')).toBe(
        false,
      );

      expect(
        resolveMediaDownloadTarget({
          src: 'art_123.webp',
          canvasId: 'c-1',
          label: 'Renamed Cover',
          defaultExt: '.png',
          fallbackStem: 'image',
        }),
      ).toEqual({
        kind: 'artifact',
        canvasId: 'c-1',
        key: 'art_123.webp',
        filename: 'Renamed Cover.webp',
      });

      expect(
        resolveMediaDownloadTarget({
          src: '/api/canvas/legacy-c/artifact/my%20deck.pptx',
          canvasId: 'c-1',
          label: 'Q4 Deck',
          defaultExt: officeDefaultExtension('pptx'),
          fallbackStem: officeFallbackStem('pptx'),
        }),
      ).toEqual({
        kind: 'artifact',
        canvasId: 'legacy-c',
        key: 'my deck.pptx',
        filename: 'Q4 Deck.pptx',
      });

      expect(
        resolveMediaDownloadTarget({
          src: 'data:image/svg+xml;utf8,%3Csvg%2F%3E',
          canvasId: 'c-1',
          label: 'Vector Icon',
          defaultExt: '.png',
          fallbackStem: 'image',
        }),
      ).toEqual({
        kind: 'data-url',
        dataUrl: 'data:image/svg+xml;utf8,%3Csvg%2F%3E',
        filename: 'Vector Icon.svg',
      });
    });

    it('resolves Web downloads for HTML artifacts, data HTML, and MHTML snapshots while excluding snapshot-less URLs and Interactive Views', () => {
      expect(
        canDownloadWebSource({
          src: 'https://example.com',
          mhtmlArtifact: undefined,
        }),
      ).toBe(false);

      expect(
        canDownloadWebSource({
          src: 'https://example.com',
          mhtmlArtifact: 'snap_99.mhtml',
        }),
      ).toBe(true);

      expect(
        canDownloadWebSource({
          src: 'app_bundle.html',
          isInteractiveView: true,
        }),
      ).toBe(false);

      expect(
        resolveWebDownloadTarget({
          src: 'https://example.com/post',
          mhtmlArtifact: 'snap_99.mhtml',
          canvasId: 'c-1',
          label: 'Saved Blog Post',
        }),
      ).toEqual({
        kind: 'artifact',
        canvasId: 'c-1',
        key: 'snap_99.mhtml',
        filename: 'Saved Blog Post.mhtml',
      });
    });
  });

  describe('execution & error feedback', () => {
    it('preflights ?check=true before triggering a streaming attachment download', async () => {
      const target = resolveMediaDownloadTarget({
        src: 'art_doc.pdf',
        canvasId: 'c-1',
        label: '季度报告',
        defaultExt: '.pdf',
        fallbackStem: 'document',
      });
      if (!target) throw new Error('Expected artifact target');

      await downloadMediaTarget(target);

      expect(mocks.apiFetch).toHaveBeenCalledWith(
        '/canvas/c-1/artifact/art_doc.pdf?check=true',
      );
      expect(clickedAnchors).toEqual([
        {
          href: `http://localhost:3001/api/canvas/c-1/artifact/art_doc.pdf?download=1&filename=${encodeURIComponent('季度报告.pdf')}`,
          download: '季度报告.pdf',
        },
      ]);
    });

    it('surfaces preflight 404/ApiError via danger toast without navigating', async () => {
      mocks.apiFetch.mockRejectedValueOnce(
        new ApiError(404, { message: 'Artifact not found' }, 'Failed'),
      );

      triggerMediaDownload({
        src: 'missing.pdf',
        canvasId: 'c-1',
        label: 'Missing Doc',
        defaultExt: '.pdf',
        fallbackStem: 'document',
      });

      await vi.waitFor(() => {
        expect(mocks.toast).toHaveBeenCalledWith('Artifact not found', {
          tone: 'danger',
        });
      });
      expect(clickedAnchors).toEqual([]);
    });

    it('decodes base64 data URLs and exports pure Note Markdown without frontmatter', async () => {
      const decoded = dataUrlToBlob(
        'data:text/html;base64,PGgxPkhlbGxvPC9oMT4=',
      );
      expect(decoded.type).toBe('text/html');
      expect(await decoded.text()).toBe('<h1>Hello</h1>');

      triggerNoteDownload({
        content: '# Sprint Notes\n\n- Ship #427 cleanly\n',
        label: 'Sprint Notes',
      });

      expect(clickedAnchors).toEqual([
        {
          href: 'blob:http://localhost/mock-1',
          download: 'Sprint Notes.md',
        },
      ]);
      expect(createdBlobs).toHaveLength(1);
      expect(createdBlobs[0]?.type).toBe('text/markdown;charset=utf-8');
      expect(await createdBlobs[0]?.text()).toBe(
        '# Sprint Notes\n\n- Ship #427 cleanly\n',
      );
    });
  });
});
