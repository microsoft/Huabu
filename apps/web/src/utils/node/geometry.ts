/**
 * @file Geometry-edit resolution for `SET_NODE_GEOMETRY`.
 *
 * The toolbar size picker reports each axis independently — only the
 * dimension(s) the user actually edited are present. This helper folds
 * the partial edit against the node's current state into a fully-formed
 * `{ width, height? }` payload, applying the contract documented on
 * `SET_NODE_GEOMETRY` (height `undefined` = revert to auto-sizing).
 *
 * Returns `null` when the resolved width is not a positive finite number
 * (e.g. an un-mounted node has no measured size and no `style.width`).
 * Callers must skip the item in that case — passing `width: 0` to the
 * command would corrupt the node's style and break parent-frame fitting.
 */

import { getNodeSize } from './size';

import type { Node } from '@xyflow/react';

export interface GeometryEdit {
  width?: number;
  height?: number;
}

export interface ResolvedGeometry {
  width: number;
  /**
   * `undefined` means "no explicit height" — the command will clear any
   * pinned height and revert the node to content-driven auto-sizing.
   */
  height: number | undefined;
}

/**
 * Resolve a partial width/height edit against the node's current state.
 *
 * Width: `edit.width` → `style.width` → `measured.width`. Returns `null`
 * if none of those produce a positive finite value (skip this node).
 *
 * Height: `edit.height` → `style.height`. Falling back to `style.height`
 * (rather than `measured.height`) preserves the node's pinning state —
 * an auto-height note left blank by the user stays auto, while a fixed
 * one keeps its pinned value.
 */
export function resolveGeometryEdit(
  node: Node,
  edit: GeometryEdit,
): ResolvedGeometry | null {
  const styleWidth = node.style?.width as number | undefined;
  const styleHeight = node.style?.height as number | undefined;
  const { width: measuredW } = getNodeSize(node);

  const fallbackW =
    typeof styleWidth === 'number' && styleWidth > 0
      ? styleWidth
      : measuredW > 0
        ? measuredW
        : undefined;
  const nextW = edit.width ?? fallbackW;
  if (typeof nextW !== 'number' || !Number.isFinite(nextW) || nextW <= 0) {
    return null;
  }

  const nextH = edit.height ?? styleHeight;

  return {
    width: nextW,
    height: typeof nextH === 'number' ? nextH : undefined,
  };
}
