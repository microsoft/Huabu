// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Azure OpenAI image-generation capability registry.
 *
 * Single source of truth for **what each supported image model family
 * actually accepts**: legal size strings, legal quality strings, and
 * default quality. Consumed by:
 *
 *   - **server** — runtime validation before hitting the Azure
 *     `/images/generations` (or `/images/edits`) endpoint, and dynamic
 *     description injection into the `generate_image` tool so the
 *     agent's view of "what is legal" matches the user's currently
 *     configured deployment.
 *   - **web Settings UI** — populate the model-family dropdown and the
 *     quality dropdown options (per-family).
 *
 * No runtime dependencies — pure data + pure functions — so it can be
 * imported from either bundle without dragging in zod / Node APIs.
 *
 * **First-batch coverage** is exactly the three gpt-image-* models we
 * ship today (validated against Microsoft Learn docs, 2026-06):
 *
 *   | family             | sizes                                  | qualities         |
 *   |--------------------|----------------------------------------|-------------------|
 *   | gpt-image-1        | 1024x1024 / 1024x1536 / 1536x1024 / auto | low/medium/high/auto |
 *   | gpt-image-1-mini   | same                                   | same              |
 *   | gpt-image-2        | flexible (edge × 16, long-edge ≤3840, AR ≤3:1, total px 655_360–8_294_400) | same |
 *
 * To add a model family later: extend {@link ImageModelFamily}, add a
 * row to {@link IMAGE_CAPABILITIES}, and update any consuming UI.
 */

// ─── Type ─────────────────────────────────────────────────────────────────

/** The supported gpt-image-* model families. */
export const IMAGE_MODEL_FAMILIES = [
  'gpt-image-1',
  'gpt-image-2',
  'gpt-image-1-mini',
] as const;

export type ImageModelFamily = (typeof IMAGE_MODEL_FAMILIES)[number];

/** Quality keyword accepted by every supported family today. */
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto';

/**
 * Free-form size constraints for families like gpt-image-2 that
 * accept arbitrary `WIDTHxHEIGHT` strings rather than a fixed enum.
 * All values are inclusive bounds.
 */
export interface FreeSizeConstraints {
  /** Each edge length must be a multiple of this. */
  edgeMultiple: number;
  /** Longer of the two edges cannot exceed this many pixels. */
  longEdgeMax: number;
  /** Max aspect ratio `max(w,h) / min(w,h)` (e.g. 3 means 3:1). */
  aspectRatioMax: number;
  /** Inclusive lower bound on `width * height`. */
  pixelCountMin: number;
  /** Inclusive upper bound on `width * height`. */
  pixelCountMax: number;
}

/**
 * Capability record for one model family. Discriminated by `sizeMode`:
 *
 *   - `'enum'` — `sizes` is the exhaustive list of legal strings.
 *   - `'free'` — any `WIDTHxHEIGHT` string that satisfies
 *     {@link FreeSizeConstraints} is legal.
 *
 * `'auto'` is always a legal size: it tells the provider to pick.
 */
export type ImageModelCapabilities =
  | {
      family: 'gpt-image-1' | 'gpt-image-1-mini';
      sizeMode: 'enum';
      sizes: readonly string[];
      qualities: readonly ImageQuality[];
      defaultQuality: ImageQuality;
    }
  | {
      family: 'gpt-image-2';
      sizeMode: 'free';
      /** A handful of recommended sizes — shown to the agent and as Settings hints. */
      sampleSizes: readonly string[];
      constraints: FreeSizeConstraints;
      qualities: readonly ImageQuality[];
      defaultQuality: ImageQuality;
    };

// ─── Registry ─────────────────────────────────────────────────────────────

/**
 * Capability matrix. Keyed by family. Frozen so mistaken in-place
 * mutation by a consumer surfaces immediately.
 */
export const IMAGE_CAPABILITIES: Readonly<
  Record<ImageModelFamily, ImageModelCapabilities>
> = Object.freeze({
  'gpt-image-1': {
    family: 'gpt-image-1',
    sizeMode: 'enum',
    sizes: ['1024x1024', '1024x1536', '1536x1024', 'auto'] as const,
    qualities: ['low', 'medium', 'high', 'auto'] as const,
    defaultQuality: 'low',
  },
  'gpt-image-1-mini': {
    family: 'gpt-image-1-mini',
    sizeMode: 'enum',
    sizes: ['1024x1024', '1024x1536', '1536x1024', 'auto'] as const,
    qualities: ['low', 'medium', 'high', 'auto'] as const,
    defaultQuality: 'low',
  },
  'gpt-image-2': {
    family: 'gpt-image-2',
    sizeMode: 'free',
    sampleSizes: [
      '1024x1024',
      '1024x1536',
      '1536x1024',
      '2048x2048',
      'auto',
    ] as const,
    constraints: {
      edgeMultiple: 16,
      longEdgeMax: 3840,
      aspectRatioMax: 3,
      pixelCountMin: 655_360,
      pixelCountMax: 8_294_400,
    },
    qualities: ['low', 'medium', 'high', 'auto'] as const,
    defaultQuality: 'low',
  },
});

/** Default family used when no Settings entry exists yet. */
export const DEFAULT_IMAGE_MODEL_FAMILY: ImageModelFamily = 'gpt-image-2';

/**
 * Default Azure OpenAI API version for image generation. Used as both
 * the value pre-filled into the Settings input and as the server-side
 * fallback when nothing has been persisted — so a user who leaves the
 * pre-filled field untouched still gets a working configuration.
 *
 * The `/images/generations` endpoint for `gpt-image-1` / `gpt-image-2`
 * requires `2025-04-01-preview` or later.
 */
export const DEFAULT_AZURE_IMAGE_API_VERSION = '2025-04-01-preview';

// ─── Accessors ────────────────────────────────────────────────────────────

/** Narrow {@link IMAGE_MODEL_FAMILIES} membership check. */
export function isImageModelFamily(v: unknown): v is ImageModelFamily {
  return (
    typeof v === 'string' &&
    (IMAGE_MODEL_FAMILIES as readonly string[]).includes(v)
  );
}

/**
 * Look up the capability record for a family. Falls back to
 * {@link DEFAULT_IMAGE_MODEL_FAMILY} when the input is unrecognised
 * (typo in stored config, legacy entry, etc.) so callers never have
 * to branch on `undefined`.
 */
export function getImageCapabilities(
  family: ImageModelFamily | string | undefined,
): ImageModelCapabilities {
  if (isImageModelFamily(family)) return IMAGE_CAPABILITIES[family];
  return IMAGE_CAPABILITIES[DEFAULT_IMAGE_MODEL_FAMILY];
}

// ─── Validation ───────────────────────────────────────────────────────────

/**
 * Validation result. `ok:false` carries a short human-readable
 * `reason` plus 1-3 `suggestions` the caller can surface in an error
 * message ("did you mean 1024x1024 / 1024x1536 …").
 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; suggestions: string[] };

/**
 * Parse a `WIDTHxHEIGHT` string. Returns `null` on any malformed
 * input. `'auto'` is handled by the caller, not here.
 */
function parseSizeString(
  size: string,
): { width: number; height: number } | null {
  const m = size.match(/^(\d+)x(\d+)$/i);
  if (!m) return null;
  const width = Number.parseInt(m[1], 10);
  const height = Number.parseInt(m[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Validate a `size` value against a family's capabilities. Accepts
 * either the enumerated literals (enum mode) or any `WIDTHxHEIGHT`
 * satisfying the family's {@link FreeSizeConstraints} (free mode).
 * `'auto'` is always legal.
 */
export function validateImageSize(
  family: ImageModelFamily | string | undefined,
  size: string,
): ValidationResult {
  const caps = getImageCapabilities(family);
  if (size === 'auto') return { ok: true };

  if (caps.sizeMode === 'enum') {
    if (caps.sizes.includes(size)) return { ok: true };
    return {
      ok: false,
      reason: `Size "${size}" is not supported by deployment "${caps.family}".`,
      suggestions: [...caps.sizes],
    };
  }

  // free mode
  const parsed = parseSizeString(size);
  if (!parsed) {
    return {
      ok: false,
      reason: `Size "${size}" is not a valid WIDTHxHEIGHT string.`,
      suggestions: [...caps.sampleSizes],
    };
  }
  const { width, height } = parsed;
  const c = caps.constraints;
  if (width % c.edgeMultiple !== 0 || height % c.edgeMultiple !== 0) {
    return {
      ok: false,
      reason: `Size "${size}" rejected: both edges must be a multiple of ${c.edgeMultiple}.`,
      suggestions: [...caps.sampleSizes],
    };
  }
  const longEdge = Math.max(width, height);
  if (longEdge > c.longEdgeMax) {
    return {
      ok: false,
      reason: `Size "${size}" rejected: long edge ${longEdge}px exceeds the ${c.longEdgeMax}px limit.`,
      suggestions: [...caps.sampleSizes],
    };
  }
  const shortEdge = Math.min(width, height);
  const ratio = shortEdge === 0 ? Infinity : longEdge / shortEdge;
  if (ratio > c.aspectRatioMax) {
    return {
      ok: false,
      reason: `Size "${size}" rejected: aspect ratio ${ratio.toFixed(2)}:1 exceeds the ${c.aspectRatioMax}:1 limit.`,
      suggestions: [...caps.sampleSizes],
    };
  }
  const pixels = width * height;
  if (pixels < c.pixelCountMin || pixels > c.pixelCountMax) {
    return {
      ok: false,
      reason: `Size "${size}" rejected: ${pixels.toLocaleString()} total pixels is outside the allowed range ${c.pixelCountMin.toLocaleString()}–${c.pixelCountMax.toLocaleString()}.`,
      suggestions: [...caps.sampleSizes],
    };
  }
  return { ok: true };
}

/**
 * Validate a `quality` value against a family's capabilities.
 * Returns `ok:true` for the wildcard `'auto'` even on families that
 * don't list it explicitly (treated as "let the server pick"), but
 * the registry currently lists `'auto'` everywhere so this is a
 * no-op safety net.
 */
export function validateImageQuality(
  family: ImageModelFamily | string | undefined,
  quality: string,
): ValidationResult {
  const caps = getImageCapabilities(family);
  if ((caps.qualities as readonly string[]).includes(quality)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Quality "${quality}" is not supported by deployment "${caps.family}".`,
    suggestions: [...caps.qualities],
  };
}

// ─── Prompt helpers ───────────────────────────────────────────────────────

/**
 * Render a one-paragraph human-readable summary of the family's
 * legal sizes, suitable for inlining into the `generate_image` tool
 * description so the agent picks sensible values for the user's
 * currently configured deployment.
 */
export function describeSizesForPrompt(
  family: ImageModelFamily | string | undefined,
): string {
  const caps = getImageCapabilities(family);
  if (caps.sizeMode === 'enum') {
    return `Allowed sizes: ${caps.sizes.join(', ')}.`;
  }
  const c = caps.constraints;
  return (
    `Sizes are flexible: any WIDTHxHEIGHT where both edges are a multiple of ${c.edgeMultiple}, ` +
    `long edge ≤ ${c.longEdgeMax}px, aspect ratio ≤ ${c.aspectRatioMax}:1, ` +
    `total pixels between ${c.pixelCountMin.toLocaleString()} and ${c.pixelCountMax.toLocaleString()}. ` +
    `Recommended: ${caps.sampleSizes.join(', ')}.`
  );
}

/**
 * Render a one-line summary of the family's legal `quality` values
 * plus its default. Mirrors {@link describeSizesForPrompt} and is
 * intended for the same tool-description injection site.
 */
export function describeQualitiesForPrompt(
  family: ImageModelFamily | string | undefined,
): string {
  const caps = getImageCapabilities(family);
  return `Allowed qualities: ${caps.qualities.join(', ')} (default: ${caps.defaultQuality}).`;
}
