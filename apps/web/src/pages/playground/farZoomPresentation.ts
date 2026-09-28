// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { FAR_ZOOM_DESIGN } from '@/components/Nodes/design/farZoomDesign';
import {
  resolveFarLabelLayout,
  resolveNodePresentation,
  SEMANTIC_ZOOM_CONFIG,
} from '@/config/semanticZoom';

export { farDescriptionLines } from '@/components/Nodes/design/farZoomDesign';
export { farFrameRegionPresentation } from '@/components/Nodes/frame/frameZoom';

/** Compatibility names for shared screen-pixel metrics and LOD boundaries. */
export const FAR_ZOOM_STUDY = {
  ...FAR_ZOOM_DESIGN,
  contentZoom: SEMANTIC_ZOOM_CONFIG.minimalZoom.exit,
  handoffZoom: SEMANTIC_ZOOM_CONFIG.minimalZoom.enter,
} as const;

function visibleAbove(
  value: number,
  exit: number,
  enter: number,
  previous?: boolean,
) {
  return (
    value >=
    (previous === undefined ? (exit + enter) / 2 : previous ? exit : enter)
  );
}

export interface FarNodeState {
  contentOpacity: number;
  labelRetained: boolean;
}

export function farNodePresentation(
  width: number,
  height: number,
  zoom: number,
  groupNameOpacity = 0,
  previous?: FarNodeState,
  borderScreenInset = 0,
) {
  const contentVisible =
    resolveNodePresentation(
      zoom,
      width,
      height,
      previous?.contentOpacity === 0 ? 'minimal' : 'overview',
      false,
    ) !== 'minimal';
  const layout = resolveFarLabelLayout(
    Math.max(0, width - 2 * borderScreenInset),
    Math.max(0, height - 2 * borderScreenInset),
    previous?.labelRetained,
  );
  const grouped = groupNameOpacity === 1;
  // Legacy group-name takeover remains exclusive to this playground.
  const labelRetained =
    layout.labelRetained &&
    (!grouped || visibleAbove(width, 68, 80, previous?.labelRetained));
  return {
    ...layout,
    contentOpacity: contentVisible ? 1 : 0,
    labelOpacity: !contentVisible && labelRetained ? 1 : 0,
    labelRetained,
  };
}

export function farFramePresentation(
  width: number,
  headerHeight: number,
  naturalFont: number,
  previousVisible?: boolean,
) {
  const fontSize = Math.max(14, naturalFont);
  const lineHeight = fontSize * 1.2;
  // Keep the name in the existing header band, never over child content.
  const fits = headerHeight >= lineHeight && width >= 48;
  const visible =
    fits &&
    visibleAbove(width, 64, 80, previousVisible) &&
    visibleAbove(headerHeight - lineHeight, 0, 2, previousVisible);
  const opacity = visible ? 1 : 0;
  return { fontSize, lineHeight, opacity };
}
