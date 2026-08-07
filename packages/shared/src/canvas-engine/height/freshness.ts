// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Auto-height hint keying and freshness.
 *
 * A persisted intrinsic height is only meaningful together with proof of
 * *what it was measured against*. That proof is the {@link AutoHeightKey}:
 * the rendering-pipeline version plus the node's content revision. If
 * either has moved, the stored number is a usable footprint but not a
 * correct one.
 *
 * The rule this module exists to enforce: **freshness is never
 * fabricated**. A hint may only claim a key a measurement actually
 * produced it under, which is why nothing else in the codebase is
 * allowed to synthesize one.
 */

import { nodeRevisionOf } from '../change.js';

import type { AutoHeightHint } from '../../types/canvas/node.js';
import type { Node } from '@xyflow/react';

/**
 * Version of the note rendering pipeline as far as height is concerned.
 *
 * Bump this whenever a change can alter the rendered height of unchanged
 * content — typography tokens, note padding, editor plugin chrome, the
 * measurement rule itself. Every stored hint becomes `stale` on the next
 * load, which costs one re-measurement per node and nothing else.
 */
export const HEIGHT_LAYOUT_VERSION = 4;

/**
 * Identity of the thing an intrinsic height was measured against.
 * Format: `` `${HEIGHT_LAYOUT_VERSION}:${nodeRevisionOf({ content })}` ``.
 *
 * Kept as one opaque string rather than separate fields because callers
 * only ever ask "does this still apply?", which is one comparison. The
 * node's width is deliberately *not* part of the key: it is a stored
 * property of the node, and the conversion from intrinsic to layout
 * height already accounts for it.
 */
export type AutoHeightKey = string;

/**
 * The key an auto height measured *now* would be valid for.
 *
 * Requires hydrated content — persisted topology strips `data.content`,
 * so callers holding a stripped node must hydrate first, exactly as they
 * already must for {@link nodeRevisionOf}.
 */
export function autoHeightKey(node: Node): AutoHeightKey {
  const data = node.data as { content?: unknown; src?: unknown } | undefined;
  const revision = nodeRevisionOf({
    content: typeof data?.content === 'string' ? data.content : undefined,
    src: typeof data?.src === 'string' ? data.src : undefined,
  });
  return `${HEIGHT_LAYOUT_VERSION}:${revision}`;
}

/**
 * How much a stored hint can be trusted.
 *
 * - `current` — measured against the node as it is now. Usable as-is.
 * - `stale` — a real measurement, but of different content or a different
 *   rendering pipeline. Usable as a seed; must be re-measured.
 * - `missing` — nothing stored. The node has no footprint at all, which
 *   makes it the highest-value target for prewarming.
 */
export type AutoHeightFreshness = 'current' | 'stale' | 'missing';

export interface AutoHeightHintRead {
  /** Absent only when `freshness` is `missing`. */
  hint?: AutoHeightHint;
  freshness: AutoHeightFreshness;
}

/** Read a node's stored auto-height hint together with its freshness. */
export function readAutoHeightHint(node: Node): AutoHeightHintRead {
  const hint = (node.data as { autoHeight?: unknown } | undefined)?.autoHeight;
  if (!isAutoHeightHint(hint)) return { freshness: 'missing' };

  // A provisional measurement was committed before the content had fully
  // settled (typically undecoded images). It is a real number, so it is a
  // valid seed, but it never counts as proof.
  if (hint.provisional) return { hint, freshness: 'stale' };

  return {
    hint,
    freshness: hint.measuredFor === autoHeightKey(node) ? 'current' : 'stale',
  };
}

function isAutoHeightHint(value: unknown): value is AutoHeightHint {
  if (!value || typeof value !== 'object') return false;
  const hint = value as Partial<AutoHeightHint>;
  return (
    typeof hint.intrinsicHeight === 'number' &&
    Number.isFinite(hint.intrinsicHeight) &&
    hint.intrinsicHeight > 0 &&
    typeof hint.measuredFor === 'string'
  );
}
