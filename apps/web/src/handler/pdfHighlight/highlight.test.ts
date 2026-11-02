// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it, vi } from 'vitest';

import { computeHighlightUpdate } from './highlight';

afterEach(() => vi.unstubAllGlobals());

it('creates and toggles highlights when HTTP exposes getRandomValues but not randomUUID', () => {
  vi.stubGlobal('crypto', {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  });
  const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.02 };
  const selection = new Map([[0, [rect]]]);

  const highlights = computeHighlightUpdate([], selection);

  expect(highlights).toHaveLength(1);
  expect(highlights[0]).toEqual({
    id: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
    pageIndex: 0,
    rects: [rect],
  });
  expect(computeHighlightUpdate([], selection)[0].id).not.toBe(
    highlights[0].id,
  );
  expect(computeHighlightUpdate(highlights, selection)).toEqual([]);
});
