// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Node height subsystem — public surface.
 *
 * The internal split is:
 * - `policy.ts`      - per-node-type height ownership + reference widths
 * - `compute.ts`     - intrinsic content height → node layout height
 * - `freshness.ts`   - hint keying and "can this number be trusted?"
 * - `materialize.ts` - applying a hint to concrete node geometry
 *
 * See `docs/proposals/node-height-ownership-model.md`.
 */

export {
  type HeightKind,
  type HeightMode,
  type HeightPolicy,
  NODE_SHELL_INSET,
  getHeightPolicy,
  getHeightRefWidth,
  isAlwaysAutoHeightType,
  isAutoHeightByDefaultType,
  resolveHeightMode,
} from './policy.js';

export {
  HEIGHT_QUANTIZATION_STEP,
  contentScaleFor,
  intrinsicToLayoutHeight,
  quantizeHeight,
} from './compute.js';

export {
  type AutoHeightFreshness,
  type AutoHeightHintRead,
  type AutoHeightKey,
  HEIGHT_LAYOUT_VERSION,
  autoHeightKey,
  readAutoHeightHint,
} from './freshness.js';

export {
  materializeAutoHeight,
  materializeAutoHeights,
  resolveAutoLayoutHeight,
} from './materialize.js';
