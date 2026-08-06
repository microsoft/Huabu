// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for the image-capability registry — the static metadata
 * the server uses to validate `generate_image` args and the web
 * Settings UI uses to populate the model-family / quality dropdowns.
 *
 * Coverage focus:
 *   - `validateImageSize` for both `'enum'` (gpt-image-1 family) and
 *     `'free'` (gpt-image-2) modes, including each free-mode
 *     constraint (edge multiple, long-edge cap, aspect ratio,
 *     pixel-count bounds).
 *   - `validateImageQuality` for the shared `low/medium/high/auto`
 *     keyword set.
 *   - `getImageCapabilities` fallback when fed an unknown family
 *     (silent fallback to {@link DEFAULT_IMAGE_MODEL_FAMILY} so
 *     callers never have to branch on `undefined`).
 *   - The `describe*ForPrompt` helpers emit non-empty strings (the
 *     tool-description injection relies on this).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IMAGE_MODEL_FAMILY,
  IMAGE_MODEL_FAMILIES,
  describeQualitiesForPrompt,
  describeSizesForPrompt,
  getImageCapabilities,
  isImageModelFamily,
  validateImageQuality,
  validateImageSize,
} from '../image-capabilities.js';

describe('IMAGE_MODEL_FAMILIES', () => {
  it('lists exactly the first-batch models', () => {
    expect([...IMAGE_MODEL_FAMILIES]).toEqual([
      'gpt-image-1',
      'gpt-image-2',
      'gpt-image-1-mini',
    ]);
  });

  it('defaults to gpt-image-2 (the model shipped before the family field existed)', () => {
    expect(DEFAULT_IMAGE_MODEL_FAMILY).toBe('gpt-image-2');
  });
});

describe('isImageModelFamily', () => {
  it('accepts every member of the registry', () => {
    for (const f of IMAGE_MODEL_FAMILIES) {
      expect(isImageModelFamily(f)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const v of ['dall-e-3', 'gpt-image-3', '', undefined, null, 42]) {
      expect(isImageModelFamily(v)).toBe(false);
    }
  });
});

describe('getImageCapabilities', () => {
  it('returns the matching record for a known family', () => {
    expect(getImageCapabilities('gpt-image-1').family).toBe('gpt-image-1');
    expect(getImageCapabilities('gpt-image-2').family).toBe('gpt-image-2');
    expect(getImageCapabilities('gpt-image-1-mini').family).toBe(
      'gpt-image-1-mini',
    );
  });

  it('falls back to the default family for unknown / missing input', () => {
    expect(getImageCapabilities(undefined).family).toBe(
      DEFAULT_IMAGE_MODEL_FAMILY,
    );
    expect(getImageCapabilities('dall-e-3').family).toBe(
      DEFAULT_IMAGE_MODEL_FAMILY,
    );
  });
});

describe('validateImageSize — enum families', () => {
  it('accepts every listed size for gpt-image-1', () => {
    for (const s of ['1024x1024', '1024x1536', '1536x1024', 'auto']) {
      expect(validateImageSize('gpt-image-1', s).ok).toBe(true);
    }
  });

  it('rejects an unlisted size and surfaces the legal list as suggestions', () => {
    const res = validateImageSize('gpt-image-1', '512x512');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/not supported/);
    expect(res.suggestions).toContain('1024x1024');
  });

  it('treats gpt-image-1-mini the same as gpt-image-1', () => {
    expect(validateImageSize('gpt-image-1-mini', '1024x1536').ok).toBe(true);
    expect(validateImageSize('gpt-image-1-mini', '2048x2048').ok).toBe(false);
  });
});

describe('validateImageSize — gpt-image-2 (free mode)', () => {
  it('accepts a square in-range size', () => {
    expect(validateImageSize('gpt-image-2', '1024x1024').ok).toBe(true);
  });

  it('accepts auto', () => {
    expect(validateImageSize('gpt-image-2', 'auto').ok).toBe(true);
  });

  it('rejects a malformed string', () => {
    const res = validateImageSize('gpt-image-2', 'not-a-size');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/valid WIDTHxHEIGHT/);
  });

  it('rejects an edge that is not a multiple of 16', () => {
    // 1000x1024: 1000 % 16 = 8.
    const res = validateImageSize('gpt-image-2', '1000x1024');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/multiple of 16/);
  });

  it('rejects a long edge above 3840px', () => {
    // 3856x1024: 3856 = 241 * 16, but exceeds 3840.
    const res = validateImageSize('gpt-image-2', '3856x1024');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/long edge/);
  });

  it('rejects an aspect ratio above 3:1', () => {
    // 3072x1024 = exactly 3:1 → allowed.
    expect(validateImageSize('gpt-image-2', '3072x1024').ok).toBe(true);
    // 3840x1024 = 3.75:1 → rejected.
    const res = validateImageSize('gpt-image-2', '3840x1024');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/aspect ratio/);
  });

  it('rejects sizes whose total pixel count is below the floor', () => {
    // 512x512 = 262_144 px, both edges multiples of 16, AR 1:1, long
    // edge 512 ≤ 3840 — only the pixel-count floor catches it.
    const res = validateImageSize('gpt-image-2', '512x512');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/total pixels/);
  });
});

describe('validateImageQuality', () => {
  it('accepts the shared low/medium/high/auto keywords on every family', () => {
    for (const f of IMAGE_MODEL_FAMILIES) {
      for (const q of ['low', 'medium', 'high', 'auto']) {
        expect(validateImageQuality(f, q).ok).toBe(true);
      }
    }
  });

  it('rejects unknown keywords with a suggestion list', () => {
    const res = validateImageQuality('gpt-image-2', 'ultra');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.suggestions).toContain('high');
  });
});

describe('describe* helpers', () => {
  it('emits a non-empty enum-mode summary for gpt-image-1', () => {
    expect(describeSizesForPrompt('gpt-image-1')).toMatch(/1024x1024/);
  });

  it('emits a non-empty free-mode summary for gpt-image-2 mentioning the constraints', () => {
    const text = describeSizesForPrompt('gpt-image-2');
    expect(text).toMatch(/flexible/);
    expect(text).toMatch(/3840/);
    expect(text).toMatch(/16/);
  });

  it('emits a quality summary that includes the default keyword', () => {
    const text = describeQualitiesForPrompt('gpt-image-2');
    expect(text).toMatch(/default: low/);
  });
});
