// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { CanvasGesturePhase } from '@/handler/canvasGestureSession';

/** Whether a normally released Sketch draw gesture contains ink to persist. */
export function shouldCommitSketchStroke(
  phase: CanvasGesturePhase | null,
  pointCount: number,
): boolean {
  return phase !== null && pointCount > 0;
}
