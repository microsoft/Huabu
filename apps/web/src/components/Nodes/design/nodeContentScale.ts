// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  contentScaleFor,
  type HeightPolicy,
} from '@huabu/shared/canvas-engine';

// PDF/Web overview spacing retains its historical reference-width scale.
// Ordinary Note, PDF/Web and Office typography does not use this scale.
const CARD_CONTENT_POLICY: HeightPolicy = { kind: 'manual', refWidth: 400 };

export function nodeCardContentScale(width: number): number {
  return contentScaleFor(CARD_CONTENT_POLICY, width);
}
