// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { dragPayloadToMarkdown } from '../io/payloadToMarkdown';

import type { DragPayload } from '../io/dragDrop';

const baseOrigin = { type: 'user-pasted' } as const;

describe('dragPayloadToMarkdown', () => {
  it('returns the trimmed note content verbatim', () => {
    const payload: DragPayload = {
      kind: 'note',
      dragId: 'd1',
      origin: baseOrigin,
      data: { content: '  # hello\n\nworld\n  ' },
    };
    expect(dragPayloadToMarkdown(payload)).toBe('# hello\n\nworld');
  });

  it('returns null for an empty note payload', () => {
    const payload: DragPayload = {
      kind: 'note',
      dragId: 'd2',
      origin: baseOrigin,
      data: { content: '   \n   ' },
    };
    expect(dragPayloadToMarkdown(payload)).toBeNull();
  });

  it('builds a markdown image with a label', () => {
    const payload: DragPayload = {
      kind: 'image',
      dragId: 'd3',
      origin: baseOrigin,
      data: { src: 'https://x.test/a.png', label: 'Sunset' },
    };
    expect(dragPayloadToMarkdown(payload)).toBe(
      '![Sunset](https://x.test/a.png)',
    );
  });

  it('builds a markdown image with empty alt when no label provided', () => {
    const payload: DragPayload = {
      kind: 'image',
      dragId: 'd4',
      origin: baseOrigin,
      data: { src: 'https://x.test/a.png' },
    };
    expect(dragPayloadToMarkdown(payload)).toBe('![](https://x.test/a.png)');
  });

  it('escapes bracket-bearing image labels', () => {
    const payload: DragPayload = {
      kind: 'image',
      dragId: 'd5',
      origin: baseOrigin,
      data: { src: 'https://x.test/a.png', label: 'A [tricky] name' },
    };
    expect(dragPayloadToMarkdown(payload)).toBe(
      '![A \\[tricky\\] name](https://x.test/a.png)',
    );
  });

  it('returns null when image src is empty', () => {
    const payload: DragPayload = {
      kind: 'image',
      dragId: 'd6',
      origin: baseOrigin,
      data: { src: '   ', label: 'x' },
    };
    expect(dragPayloadToMarkdown(payload)).toBeNull();
  });

  it('leaves an artifact-key src unresolved when no canvasId is provided', () => {
    // Defensive: callers that don't pass `canvasId` accept the
    // risk of inserting an unresolved key (only safe when the src
    // is already an absolute URL).
    const payload: DragPayload = {
      kind: 'image',
      dragId: 'd-key-1',
      origin: baseOrigin,
      data: { src: 'art_abc.png', label: 'pic' },
    };
    expect(dragPayloadToMarkdown(payload)).toBe('![pic](art_abc.png)');
  });

  it('resolves an artifact-key src into a fetchable canvas-scoped URL when canvasId is provided', () => {
    const payload: DragPayload = {
      kind: 'image',
      dragId: 'd-key-2',
      origin: baseOrigin,
      data: { src: 'art_abc.png', label: 'pic' },
    };
    expect(dragPayloadToMarkdown(payload, { canvasId: 'canvas-1' })).toBe(
      '![pic](/api/canvas/canvas-1/artifact/art_abc.png)',
    );
  });

  it('leaves absolute URLs alone even when canvasId is provided', () => {
    const payload: DragPayload = {
      kind: 'image',
      dragId: 'd-key-3',
      origin: baseOrigin,
      data: { src: 'https://example.com/a.png' },
    };
    expect(dragPayloadToMarkdown(payload, { canvasId: 'canvas-1' })).toBe(
      '![](https://example.com/a.png)',
    );
  });

  it('leaves data: URLs alone even when canvasId is provided', () => {
    const payload: DragPayload = {
      kind: 'image',
      dragId: 'd-key-4',
      origin: baseOrigin,
      data: { src: 'data:image/png;base64,AAAA', label: 'inline' },
    };
    expect(dragPayloadToMarkdown(payload, { canvasId: 'canvas-1' })).toBe(
      '![inline](data:image/png;base64,AAAA)',
    );
  });

  it('renders web payloads as autolinks', () => {
    const payload: DragPayload = {
      kind: 'web',
      dragId: 'd7',
      origin: baseOrigin,
      data: { src: 'https://example.com/page' },
    };
    expect(dragPayloadToMarkdown(payload)).toBe('<https://example.com/page>');
  });

  it('returns null when web src is empty', () => {
    const payload: DragPayload = {
      kind: 'web',
      dragId: 'd8',
      origin: baseOrigin,
      data: { src: '' },
    };
    expect(dragPayloadToMarkdown(payload)).toBeNull();
  });

  it('rejects javascript: scheme for web payloads', () => {
    const payload: DragPayload = {
      kind: 'web',
      dragId: 'd9',
      origin: baseOrigin,

      data: { src: 'javascript:alert(1)' },
    };
    expect(dragPayloadToMarkdown(payload)).toBeNull();
  });

  it('rejects javascript: scheme for image payloads', () => {
    const payload: DragPayload = {
      kind: 'image',
      dragId: 'd10',
      origin: baseOrigin,

      data: { src: 'javascript:alert(1)', label: 'x' },
    };
    expect(dragPayloadToMarkdown(payload)).toBeNull();
  });

  it('rejects data:text/html image src but keeps data:image', () => {
    const html: DragPayload = {
      kind: 'image',
      dragId: 'd11',
      origin: baseOrigin,
      data: { src: 'data:text/html,<script>alert(1)</script>' },
    };
    expect(dragPayloadToMarkdown(html)).toBeNull();

    const img: DragPayload = {
      kind: 'image',
      dragId: 'd12',
      origin: baseOrigin,
      data: { src: 'data:image/png;base64,AAAA', label: 'ok' },
    };
    expect(dragPayloadToMarkdown(img)).toBe(
      '![ok](data:image/png;base64,AAAA)',
    );
  });
});
