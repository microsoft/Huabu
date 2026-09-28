// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { NOTE_SURFACE_DESIGN_CONFIG, NOTE_TRUNCATION_FADE } from './noteDesign';

export function NoteTruncationOverlay({
  counterZoomScale,
}: {
  counterZoomScale: number;
}) {
  return (
    <div
      aria-hidden
      data-note-truncation-fade=""
      className="pointer-events-none absolute right-0 bottom-0 left-0"
      style={{
        height:
          NOTE_SURFACE_DESIGN_CONFIG.truncationFadeHeight * counterZoomScale,
        background: NOTE_TRUNCATION_FADE,
      }}
    />
  );
}
