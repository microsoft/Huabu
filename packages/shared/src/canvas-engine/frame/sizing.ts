// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Frame size policy helpers — orthogonal to layout mode.
 *
 * `data.sizing` controls whether the engine's end-of-batch fit pass
 * resizes a frame to wrap its children (`'hug'`, the default) or
 * leaves the frame's size untouched (`'manual'`). Callers without
 * a typed frame node use these helpers to read the field defensively
 * (default: `'hug'`).
 */

import {
  FRAME_SIZING_MODES,
  type FrameSizing,
} from '../../types/canvas/node.js';

import type { Node } from '@xyflow/react';

/**
 * Read a frame's `data.sizing` field, falling back to the default
 * (`'hug'`). Non-frame nodes also default to `'hug'` — callers can
 * use this without first narrowing the node type.
 */
export function getFrameSizing(node: Node | undefined | null): FrameSizing {
  if (!node) return 'hug';
  const raw = (node.data as { sizing?: unknown } | undefined)?.sizing;
  return typeof raw === 'string' &&
    FRAME_SIZING_MODES.includes(raw as FrameSizing)
    ? (raw as FrameSizing)
    : 'hug';
}
