// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

import { getNodeSize, resolveHeightMode } from '@huabu/shared/canvas-engine';

import type { Node } from '@xyflow/react';

export interface GeometryEdit {
  width?: number;
  height?: number;
}

export interface ResolvedGeometry {
  width: number;
  /**
   * `'auto'` hands the height back to the renderer; a number pins it.
   * `undefined` only for a manual-height node that has no height yet.
   */
  height: number | 'auto' | undefined;
}

/**
 * Resolve a partial width/height edit against the node's current state.
 *
 * Width: `edit.width` → `style.width` → `measured.width`. Returns `null`
 * if none of those produce a positive finite value (skip this node).
 *
 * Height: `edit.height` → the node's current *ownership*. Reading the
 * ownership rather than the stored number is what keeps a width-only
 * edit from silently pinning an auto node: since auto heights became
 * materialized, `style.height` is a number in both modes and can no
 * longer tell them apart.
 */
export function resolveGeometryEdit(
  node: Node,
  edit: GeometryEdit,
): ResolvedGeometry | null {
  const styleWidth = node.style?.width as number | undefined;
  const styleHeight = node.style?.height as number | undefined;
  const { width: measuredW, height: measuredH } = getNodeSize(node);

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

  if (node.type === 'image' || node.type === 'video') {
    const fallbackH =
      typeof styleHeight === 'number' && styleHeight > 0
        ? styleHeight
        : measuredH > 0
          ? measuredH
          : undefined;
    if (fallbackW === undefined || fallbackH === undefined) return null;

    if (edit.width !== undefined && edit.height === undefined) {
      return {
        width: edit.width,
        height: edit.width * (fallbackH / fallbackW),
      };
    }
    if (edit.height !== undefined && edit.width === undefined) {
      return {
        width: edit.height * (fallbackW / fallbackH),
        height: edit.height,
      };
    }
  }

  if (edit.height !== undefined) {
    return { width: nextW, height: edit.height };
  }

  if (resolveHeightMode(node) === 'auto') {
    return { width: nextW, height: 'auto' };
  }

  return {
    width: nextW,
    height: typeof styleHeight === 'number' ? styleHeight : undefined,
  };
}
