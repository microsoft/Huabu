// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Image inlining for vision content parts.
 *
 * Resolves an attachment's image URL into base64 bytes the LLM can
 * actually see, or a typed "skipped" outcome the caller can surface as a
 * textual placeholder. Handles three source shapes:
 *   - canvas-scoped artifact keys / URLs (via the shared artifact helper),
 *   - already-baked `data:` URLs,
 *   - external `http(s)` URLs (streamed, with a hard byte cap).
 *
 * Lives apart from `attachments.ts` because byte-wrangling (data-URL
 * parsing, streaming caps, fetch) is a self-contained concern: the
 * attachment renderer only cares whether it got bytes back.
 */

import { isVisionImageMime } from '../../../../utils/mime.js';
import { resolveArtifactImageUrl } from '../../../artifact/utils.js';

/**
 * Hard cap on the decoded byte size of an image we are willing to
 * inline as base64 in a vision content part. Anything larger is
 * dropped (an explanatory text part is emitted in its place so the
 * agent can request a downsampled version) so a hostile or
 * accidentally-huge artifact cannot blow up the Node process — and,
 * just as importantly, so the resulting request body stays below
 * every upstream LLM provider's body-size limit. Most providers
 * we target reject requests around 8–10 MB total; vision-capable
 * Copilot endpoints can be tighter still. 4 MB per image leaves
 * head-room for system prompt + tool schemas + multiple attachments
 * without tripping `413 Request Entity Too Large` from the provider.
 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/** Decoded byte size of a base64 string (no allocation). */
function base64DecodedByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64.charCodeAt(len - 1) === 61 /* '=' */) padding++;
  if (b64.charCodeAt(len - 2) === 61 /* '=' */) padding++;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Outcome of resolving an image URL for vision inlining.
 *
 * - `inline`: we have base64 bytes the LLM can see.
 * - `skipped`: we resolved the URL but the image was too large to
 *   inline (`reason: 'too_large'`), the source wasn't an image
 *   (`reason: 'not_image'` / `'fetch_failed'`), or its media type is one
 *   no vision provider accepts (`reason: 'unsupported_type'`). The caller
 *   should surface a textual placeholder instead of dropping the part
 *   silently — the agent then knows to ask for a downsampled
 *   version or to inspect the node directly.
 */
export type ResolvedImage =
  | { kind: 'inline'; data: string; mimeType: string }
  | {
      kind: 'skipped';
      reason: 'too_large' | 'not_image' | 'fetch_failed' | 'unsupported_type';
      sizeBytes?: number;
      mimeType?: string;
    };

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

export async function resolveImageUrl(
  url: string,
  defaultCanvasId: string | null,
): Promise<ResolvedImage> {
  // Canvas-scoped artifacts + already-baked data: URLs go through the
  // shared helper. It returns the input unchanged for unrelated URLs
  // (external http(s), bare paths, etc.).
  //
  // `defaultCanvasId` is used when `url` is a bare artifact key
  // (`<id><ext>`) rather than a full URL. Bare keys are the canonical
  // form that the front-end now sends; full URLs are kept for legacy
  // / external references.
  const resolved = await resolveArtifactImageUrl(url, defaultCanvasId);
  if (resolved.startsWith('data:')) {
    const parsed = parseDataUrl(resolved);
    if (!parsed) {
      return { kind: 'skipped', reason: 'not_image' };
    }
    // Media type first: an unusable type stays unusable at any size, and
    // the caller's recovery advice differs between the two outcomes.
    if (!isVisionImageMime(parsed.mimeType)) {
      return {
        kind: 'skipped',
        reason: 'unsupported_type',
        mimeType: parsed.mimeType,
      };
    }
    // Apply the same byte cap we enforce on external fetches — a
    // multi-MB canvas artifact would otherwise sail through and tip
    // the request over the upstream LLM's body limit.
    const sizeBytes = base64DecodedByteLength(parsed.data);
    if (sizeBytes > MAX_INLINE_IMAGE_BYTES) {
      return {
        kind: 'skipped',
        reason: 'too_large',
        sizeBytes,
        mimeType: parsed.mimeType,
      };
    }
    return { kind: 'inline', data: parsed.data, mimeType: parsed.mimeType };
  }

  // External image URLs: fetch and inline as base64 so the LLM can see them.
  if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
    try {
      const res = await fetch(resolved, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { kind: 'skipped', reason: 'fetch_failed' };
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) {
        return { kind: 'skipped', reason: 'not_image' };
      }
      if (!isVisionImageMime(contentType)) {
        return {
          kind: 'skipped',
          reason: 'unsupported_type',
          mimeType: contentType.split(';')[0],
        };
      }

      // Cap the inlined payload so a hostile / accidentally-huge URL
      // (e.g. a multi-GB camera RAW served from a CDN) cannot exhaust
      // the Node process's heap. We honour Content-Length up-front when
      // present, and stream-read otherwise so we can stop reading the
      // moment the cap is exceeded — without this, `arrayBuffer()`
      // happily buffers the whole response regardless of size.
      const declaredSize = Number(res.headers.get('content-length') ?? '');
      if (
        Number.isFinite(declaredSize) &&
        declaredSize > MAX_INLINE_IMAGE_BYTES
      ) {
        return {
          kind: 'skipped',
          reason: 'too_large',
          sizeBytes: declaredSize,
          mimeType: contentType.split(';')[0],
        };
      }

      const body = res.body;
      if (!body) {
        // No streamable body — fall back to the buffered path but still
        // bound the result.
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.byteLength > MAX_INLINE_IMAGE_BYTES) {
          return {
            kind: 'skipped',
            reason: 'too_large',
            sizeBytes: buffer.byteLength,
            mimeType: contentType.split(';')[0],
          };
        }
        return {
          kind: 'inline',
          data: buffer.toString('base64'),
          mimeType: contentType.split(';')[0],
        };
      }

      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_INLINE_IMAGE_BYTES) {
          // Release the stream so the underlying connection can close.
          await reader.cancel().catch(() => {});
          return {
            kind: 'skipped',
            reason: 'too_large',
            sizeBytes: total,
            mimeType: contentType.split(';')[0],
          };
        }
        chunks.push(value);
      }
      const buffer = Buffer.concat(chunks);
      return {
        kind: 'inline',
        data: buffer.toString('base64'),
        mimeType: contentType.split(';')[0],
      };
    } catch {
      return { kind: 'skipped', reason: 'fetch_failed' };
    }
  }

  // Unknown scheme (bare relative path, etc.) — we can't load bytes.
  return { kind: 'skipped', reason: 'fetch_failed' };
}
