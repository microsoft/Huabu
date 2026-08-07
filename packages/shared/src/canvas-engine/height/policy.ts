// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Per-node-type height policy — the single source of truth for
 * "who owns this node's height and how is it derived".
 *
 * Before this table the same knowledge was spread across three places
 * that had to be kept in lock-step by hand:
 *
 *  - `ALWAYS_AUTO_HEIGHT_NODE_TYPES` / `DEFAULT_AUTO_HEIGHT_NODE_TYPES`
 *    in `../utils/nodeSizes.ts`
 *  - `REF_WIDTHS` in `apps/web/src/hooks/useNodeScale.ts`
 *  - a scatter of inline `typeof style.height === 'number'` checks
 *
 * The two type sets differ by exactly one entry (`note`), which is the
 * observation this table encodes: `note` is the only type whose owner
 * can change at runtime. See `docs/proposals/node-height-ownership-model.md`.
 */

import type { HeightMode } from '../../types/canvas/node.js';
import type { Node } from '@xyflow/react';

/**
 * Who owns a node type's height.
 *
 * - `content` — always derived from rendered content. The user cannot pin
 *   it, so a top-level `style.height` is never authored geometry.
 * - `toggleable` — derived by default, but the user can pin it. The owner
 *   is recorded per node in `data.heightMode`.
 * - `manual` — the height is authored (creation default or resize gesture)
 *   and content never drives it.
 */
export type HeightKind = 'content' | 'toggleable' | 'manual';

/** How a node's height is owned and how intrinsic content maps onto it. */
export interface HeightPolicy {
  kind: HeightKind;
  /**
   * Width (px) at which this node type renders its content unscaled.
   * Content-bearing containers apply `transform: scale(width / refWidth)`,
   * so a measurement is only meaningful when paired with this width.
   * Absent for types that do not scale their content with width (`text` and
   * `question` encode their scale as `data.style.fontSize` instead).
   */
  refWidth?: number;
  /**
   * Lower bound (px, unscaled) on the intrinsic content height, applied
   * before scaling. Keeps an empty node from collapsing to nothing.
   */
  minIntrinsicHeight?: number;
  /**
   * Chrome (px) that lives outside the measured element but inside the
   * node box — added after scaling. `0` where the measurement already
   * accounts for the node's own padding.
   */
  insetY?: number;
  /**
   * Floor on the content scale, so a very narrow node keeps its content
   * legible instead of shrinking without limit.
   *
   * Only meaningful for types whose height is **not** derived from the
   * scale. A floor and a derived height are in direct conflict: once the
   * floor engages, the content stops shrinking and starts laying out
   * *narrower* than the reference width, so an intrinsic height measured
   * at that reference no longer applies and the node renders short.
   *
   * `manual` types are unaffected because their box is the user's; the
   * scale only decides how large the content is drawn inside it. `note`
   * deliberately has no floor — semantic zoom already replaces its body
   * with a placeholder long before the text would become unreadable, so
   * the floor would buy nothing and cost the invariant.
   */
  minContentScale?: number;
}

/**
 * Default policy for node types not listed in {@link HEIGHT_POLICIES}:
 * a plain authored box.
 */
const MANUAL_POLICY: HeightPolicy = { kind: 'manual' };

/**
 * Vertical and horizontal chrome (px) the node shell adds around a
 * node's body.
 *
 * `NodeWrapper` gives every non-sketch node root a 3px transparent
 * border, and `box-sizing: border-box` means that border eats into the
 * geometry the store assigned — on *both* axes. The body is `h-full
 * w-full` inside it.
 *
 * Vertically this is why a layout height computed from content alone
 * leaves the body 6px short, clipping the last line and lighting up the
 * truncation affordance on a node meant to fit exactly.
 *
 * Horizontally it is why the content's layout width is the node's width
 * *minus* this, which is what {@link contentScaleFor} has to divide by
 * so that the logical layout width lands on the reference width exactly.
 * Get that wrong and the same markdown wraps differently depending on
 * where it was measured.
 *
 * Applied outside the scaled container, so it is canvas-space px and is
 * never multiplied by the content scale.
 */
export const NODE_SHELL_INSET = 6;

/**
 * Height policy per node type. Types absent from this table are `manual`.
 *
 * `refWidth` values match the creation defaults in
 * `getNodeDefaultSize` — a node created at its default width renders at
 * scale 1.
 */
const HEIGHT_POLICIES: Readonly<Record<string, HeightPolicy>> = {
  // The note body measures `.ProseMirror` plus the host's own vertical
  // padding, so the only thing left to add is the node shell itself.
  // No `minContentScale`: its height is derived from the scale, and a
  // floor would make the content lay out narrower than `refWidth`.
  note: {
    kind: 'toggleable',
    refWidth: 400,
    minIntrinsicHeight: 50,
    insetY: NODE_SHELL_INSET,
  },
  text: { kind: 'content' },
  question: { kind: 'content' },
  // Manual-height types: the box is the user's, so the scale is purely a
  // rendering decision and a legibility floor costs nothing.
  web: { kind: 'manual', refWidth: 400, minContentScale: 0.5 },
  pdf: { kind: 'manual', refWidth: 400, minContentScale: 0.5 },
  office: { kind: 'manual', refWidth: 400, minContentScale: 0.5 },
};

/** Height policy for a node type. Never `undefined`. */
export function getHeightPolicy(nodeType: string | undefined): HeightPolicy {
  return (nodeType && HEIGHT_POLICIES[nodeType]) || MANUAL_POLICY;
}

/**
 * Reference width for a node type, or `undefined` when its content does
 * not scale with width. Single source for the web `useNodeScale` hook.
 */
export function getHeightRefWidth(
  nodeType: string | undefined,
): number | undefined {
  return getHeightPolicy(nodeType).refWidth;
}

/**
 * True when a node type's height is *always* content-derived, so a
 * top-level `style.height` must never be treated as pinned geometry.
 */
export function isAlwaysAutoHeightType(nodeType: string | undefined): boolean {
  return getHeightPolicy(nodeType).kind === 'content';
}

/**
 * True when a node type is content-driven by default at creation time —
 * `content` and `toggleable` alike. Creation must not bake a nominal
 * layout height into `style.height` for these.
 */
export function isAutoHeightByDefaultType(
  nodeType: string | undefined,
): boolean {
  return getHeightPolicy(nodeType).kind !== 'manual';
}

/** Who currently owns a node's height. Re-exported for convenience. */
export type { HeightMode };

/**
 * Resolve the owner of a node's height.
 *
 * `data.heightMode` is authoritative once present. Nodes persisted before
 * the field existed fall back to the legacy encoding, where "auto" was
 * expressed as the *absence* of a top-level `style.height`. That inference
 * is the only reason the fallback exists; once a node has been normalised
 * on load it is never consulted again.
 *
 * The fallback is consulted only for nodes that predate the field —
 * creation and load normalization both write it explicitly, so anything
 * this codebase produces carries an owner. Notably it must *not* read
 * the measurement hint as evidence: a pinned note records one too, since
 * the hint describes the content rather than who owns the box.
 *
 * A `content` node is always auto regardless of what is stored, because a
 * stale `style.height` on such a node is a leftover, not an intent.
 */
export function resolveHeightMode(node: Node): HeightMode {
  const policy = getHeightPolicy(node.type);
  if (policy.kind === 'content') return 'auto';
  if (policy.kind === 'manual') return 'fixed';

  const stored = (node.data as { heightMode?: unknown } | undefined)
    ?.heightMode;
  if (stored === 'auto' || stored === 'fixed') return stored;

  const height = (node.style as { height?: unknown } | undefined)?.height;
  return typeof height === 'number' && Number.isFinite(height)
    ? 'fixed'
    : 'auto';
}
