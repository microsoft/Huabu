// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { NodePresentationMode } from '@/config/semanticZoom';

/** Video owns its body in ordinary presentation, independent of reader size. */
export function canPlayVideoInline(state: {
  mode: NodePresentationMode;
  isVisible: boolean;
  isSoleSelected: boolean;
  previewOpen: boolean;
  frameSuppressed: boolean;
}): boolean {
  return (
    state.mode !== 'minimal' &&
    state.isVisible &&
    state.isSoleSelected &&
    !state.previewOpen &&
    !state.frameSuppressed
  );
}

/** Explicit opt-in: other node bodies retain their existing gesture ownership. */
export function isVideoControlTarget(target: Element | null): boolean {
  return Boolean(target?.closest('[data-video-controls="true"]'));
}
