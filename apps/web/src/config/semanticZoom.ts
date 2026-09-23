// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  FAR_ZOOM_DESIGN,
  farLabelContentBox,
  type FarZoomDesign,
} from '@/components/Nodes/design/farZoomDesign';

/**
 * Semantic Zoom configuration.
 *
 * Viewport zoom selects minimal; screen-space geometry selects reading without
 * changing authored geometry. Minimal text uses fixed screen-pixel design
 * metrics; full/minimal visibility switches immediately with hysteresis.
 */

/** LOD levels — extensible. */
export type ZoomLOD = 'full' | 'minimal';

/**
 * What to render for a given node.
 * 'full' = original component, 'minimal' = fixed screen-size text.
 */
export type LODRenderMode = 'full' | 'minimal';

export type NodePresentationMode = 'minimal' | 'overview' | 'reading';

export const NODE_READING_THRESHOLDS = {
  enterWidth: 560,
  enterHeight: 360,
  exitWidth: 480,
  exitHeight: 300,
} as const;

/** Zoom selects far content; screen dimensions independently gate reading. */
export function resolveNodePresentation(
  zoom: number,
  screenWidth: number,
  screenHeight: number,
  previous: NodePresentationMode = 'overview',
  readingEnabled = true,
): NodePresentationMode {
  const { minimalZoom } = SEMANTIC_ZOOM_CONFIG;
  if (
    zoom < minimalZoom.enter ||
    (previous === 'minimal' && zoom < minimalZoom.exit)
  ) {
    return 'minimal';
  }
  if (!readingEnabled) return 'overview';
  const threshold = NODE_READING_THRESHOLDS;
  const reading =
    previous === 'reading'
      ? screenWidth >= threshold.exitWidth &&
        screenHeight >= threshold.exitHeight
      : screenWidth >= threshold.enterWidth &&
        screenHeight >= threshold.enterHeight;
  return reading ? 'reading' : 'overview';
}

export interface SemanticZoomConfig {
  /** Enter strictly below enter; restore ordinary content at exit or above. */
  minimalZoom: { enter: number; exit: number };
  /**
   * Per-node-type render mode at each opt-in LOD level. Node types not
   * listed here always render 'full'.
   */
  nodeLOD: Record<string, Partial<Record<ZoomLOD, LODRenderMode>>>;
}

export const SEMANTIC_ZOOM_CONFIG: SemanticZoomConfig = {
  minimalZoom: { enter: 0.25, exit: 0.3 },

  nodeLOD: {
    // Only heavy node types — all others default to 'full' at every level.
    note: { full: 'full', minimal: 'minimal' },
    pdf: { full: 'full', minimal: 'minimal' },
    web: { full: 'full', minimal: 'minimal' },
    office: { full: 'full', minimal: 'minimal' },
    video: { full: 'full', minimal: 'minimal' },
    // NOTE: `question` is intentionally NOT here. It uses the continuous zoom
    // takeover (V2) instead of the binary boundary: its agent mark slides from
    // the corner to the node centre and the card fades via `NodeTakeoverLayer`
    // / `useNodeTakeover`, driven by a representative-size band rather than this
    // zoom threshold. See proposals/question-node-zoom-lod-avatar.md.
  },
};

/**
 * Fit a far label inside inner screen-space bounds; callers subtract borders.
 * Retention is independent of content visibility and never overrides text fit.
 */
export function resolveFarLabelLayout(
  screenWidth: number,
  screenHeight: number,
  previousRetained?: boolean,
  design: FarZoomDesign = FAR_ZOOM_DESIGN,
) {
  const { labelInset, labelLine, labelFont } = design;
  const { availableWidth, availableHeight, verticalInset, lines } =
    farLabelContentBox(
      screenWidth,
      screenHeight,
      design.labelInsetInline ?? labelInset,
      labelInset,
      labelLine,
    );
  const retentionWidth =
    previousRetained === undefined ? 42 : previousRetained ? 38 : 46;
  const labelRetained =
    lines > 0 &&
    availableWidth >= labelFont * 2 &&
    screenWidth >= retentionWidth;
  return {
    availableWidth,
    availableHeight,
    verticalInset,
    lines,
    labelRetained,
  };
}
