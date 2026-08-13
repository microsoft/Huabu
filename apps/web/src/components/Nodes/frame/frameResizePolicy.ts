// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { FrameSizing } from '@huabu/shared';

export function shouldPreserveFrameAspectRatio({
  sizing,
  hasMediaChild,
}: {
  sizing: FrameSizing | undefined;
  hasMediaChild: boolean;
}): boolean {
  return sizing !== 'manual' && hasMediaChild;
}
