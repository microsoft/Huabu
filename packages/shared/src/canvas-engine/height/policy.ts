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
}

/**
 * Default policy for node types not listed in {@link HEIGHT_POLICIES}:
 * a plain authored box.
 */
const MANUAL_POLICY: HeightPolicy = { kind: 'manual' };

/**
 * Vertical chrome (px) the node shell adds around a node's body.
 *
 * `NodeWrapper` gives every non-sketch node root a 3px transparent
 * border, and `box-sizing: border-box` means that border eats into the
 * height the store assigned. The body is `h-full` inside it, so a layout
 * height computed from content alone leaves the body 6px short — enough
 * to clip the last line and light up the truncation affordance on a node
 * that is supposed to fit its content exactly.
 *
 * It is applied *after* width scaling because the border lives outside
 * the scaled container, in canvas space.
 */
const NODE_SHELL_INSET_Y = 6;

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
  note: {
    kind: 'toggleable',
    refWidth: 400,
    minIntrinsicHeight: 50,
    insetY: NODE_SHELL_INSET_Y,
  },
  text: { kind: 'content' },
  question: { kind: 'content' },
  web: { kind: 'manual', refWidth: 400 },
  pdf: { kind: 'manual', refWidth: 400 },
  office: { kind: 'manual', refWidth: 400 },
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
