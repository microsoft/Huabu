// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { FRAME_DESIGN_CONFIG } from './frameDesign';
import { getFrameAccentMarkerColor } from './frameHeaderMetrics';
import { InstructionFrameBadge } from './InstructionFrameBadge';

import type { FrameHeaderMetrics } from './frameHeaderMetrics';
import type { SpaceInstructionFrameKind } from '@huabu/shared';
import type { ReactNode } from 'react';

export function FrameHeader({
  metrics,
  accent,
  instructionKind,
  directAgentCount = 0,
  children,
}: {
  metrics: FrameHeaderMetrics;
  accent: string | null;
  instructionKind?: SpaceInstructionFrameKind | null;
  directAgentCount?: number;
  children: ReactNode;
}) {
  return (
    <div
      className="pointer-events-none absolute z-10 flex min-w-0 items-center"
      style={{
        left: metrics.left,
        top: metrics.top,
        height: metrics.height,
        maxWidth: metrics.maxWidth,
        gap: Math.max(
          FRAME_DESIGN_CONFIG.header.minGap,
          metrics.height * FRAME_DESIGN_CONFIG.header.gapRatio,
        ),
        fontSize: metrics.fontSize,
      }}
    >
      <span
        aria-hidden="true"
        className="shrink-0 rounded-full"
        style={{
          width: metrics.height * FRAME_DESIGN_CONFIG.header.markerSizeRatio,
          height: metrics.height * FRAME_DESIGN_CONFIG.header.markerSizeRatio,
          backgroundColor: getFrameAccentMarkerColor(accent),
        }}
      />
      <div className="relative inline-grid min-w-0 shrink items-center">
        {children}
      </div>
      {instructionKind ? (
        <InstructionFrameBadge
          kind={instructionKind}
          directAgentCount={directAgentCount}
          titleFontSize={metrics.fontSize}
        />
      ) : null}
    </div>
  );
}
