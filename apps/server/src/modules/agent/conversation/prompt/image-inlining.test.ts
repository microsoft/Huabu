// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { resolveImageUrl, MAX_INLINE_IMAGE_BYTES } from './image-inlining.js';

// 1x1 transparent PNG; the bytes are irrelevant to the media-type gate,
// they only have to be valid base64.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('resolveImageUrl media-type gate', () => {
  it('inlines a data URL whose type every vision provider accepts', async () => {
    const resolved = await resolveImageUrl(
      `data:image/png;base64,${TINY_PNG_B64}`,
      null,
    );
    expect(resolved).toEqual({
      kind: 'inline',
      data: TINY_PNG_B64,
      mimeType: 'image/png',
    });
  });

  it.each(['image/avif', 'image/bmp', 'image/svg+xml'])(
    'skips %s instead of letting the provider reject the whole request',
    async (mimeType) => {
      const resolved = await resolveImageUrl(
        `data:${mimeType};base64,${TINY_PNG_B64}`,
        null,
      );
      expect(resolved).toEqual({
        kind: 'skipped',
        reason: 'unsupported_type',
        mimeType,
      });
    },
  );

  it('skips artifact bytes whose extension had no known image type', async () => {
    // `resolveArtifactImageUrl` no longer guesses `image/png` for unknown
    // extensions, so these bytes must be dropped rather than mislabelled.
    const resolved = await resolveImageUrl(
      `data:application/octet-stream;base64,${TINY_PNG_B64}`,
      null,
    );
    expect(resolved).toEqual({
      kind: 'skipped',
      reason: 'unsupported_type',
      mimeType: 'application/octet-stream',
    });
  });

  it('reports an unusable media type as such even when it is also oversized', async () => {
    const oversized = 'A'.repeat(MAX_INLINE_IMAGE_BYTES * 2);
    const resolved = await resolveImageUrl(
      `data:image/avif;base64,${oversized}`,
      null,
    );
    expect(resolved).toMatchObject({
      kind: 'skipped',
      reason: 'unsupported_type',
    });
  });

  it('carries the media type on a too-large outcome so callers can pick a recovery', async () => {
    const oversized = 'A'.repeat(MAX_INLINE_IMAGE_BYTES * 2);
    const resolved = await resolveImageUrl(
      `data:image/png;base64,${oversized}`,
      null,
    );
    expect(resolved).toMatchObject({
      kind: 'skipped',
      reason: 'too_large',
      mimeType: 'image/png',
    });
  });
});
