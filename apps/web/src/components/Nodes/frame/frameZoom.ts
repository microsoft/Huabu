// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getNodeSize, indexById } from '@huabu/shared/canvas-engine';

import { FRAME_DESIGN_CONFIG, frameVisualMetricsForSize } from './frameDesign';
import {
  getFrameHeaderMetrics,
  type FrameHeaderMetrics,
} from './frameHeaderMetrics';
import { farLabelContentBox } from '../design/farZoomDesign';

import type { Node } from '@xyflow/react';

export const FRAME_ZOOM_THRESHOLDS = {
  enter: 0.08,
  exit: 0.1,
  fitRecoveryMargin: 2,
} as const;

export function frameRegionContentBox(
  screenHeight: number,
  zoom: number,
  header: FrameHeaderMetrics,
  lineHeight: number,
) {
  return farLabelContentBox(
    header.maxWidth * zoom,
    screenHeight - (header.top + FRAME_DESIGN_CONFIG.header.edgeInset) * zoom,
    0,
    0,
    lineHeight,
  );
}

/** Screen-space region budgets shared by production and the design playground. */
export function farFrameRegionPresentation(
  width: number,
  height: number,
  zoom: number,
  previousActive = false,
  headerMetrics?: FrameHeaderMetrics,
) {
  const thresholds = FRAME_ZOOM_THRESHOLDS;
  const active = zoom < (previousActive ? thresholds.exit : thresholds.enter);
  const fontSize = 10;
  const lineHeight = 15;
  const fitInset = 10;
  const maxWidth = Math.max(0, width - fitInset * 2);
  const lines = Math.max(
    0,
    Math.floor((height - fitInset * 2 - 4 * 2) / lineHeight),
  );
  const visual = frameVisualMetricsForSize(width / zoom, height / zoom);
  const header =
    headerMetrics ??
    getFrameHeaderMetrics(
      null,
      width / zoom,
      visual.titleFontSize,
      visual.headerInset,
    );
  const box = frameRegionContentBox(height, zoom, header, lineHeight);
  const fallbackFits = box.availableWidth > 0 && box.lines > 0;
  const fits = width >= 28 && height >= 49 && lines > 0 && fallbackFits;
  return {
    active,
    visible: active && fits,
    fallbackVisible: active && fallbackFits,
    fontSize,
    lineHeight,
    maxWidth,
    screenHeight: height,
    lines,
  };
}

export interface FrameZoomSnapshot {
  active: ReadonlySet<string>;
  visible: ReadonlySet<string>;
  suppressed: ReadonlySet<string>;
  regionByNode: ReadonlyMap<string, string>;
  regionZ: ReadonlyMap<string, number>;
}

export const EMPTY_FRAME_ZOOM: FrameZoomSnapshot = {
  active: new Set(),
  visible: new Set(),
  suppressed: new Set(),
  regionByNode: new Map(),
  regionZ: new Map(),
};

/** Resolve the deepest readable regions, promoting unfit branches to a fitting ancestor. */
export function resolveFrameZoom(
  nodes: Node[],
  zoom: number,
  previous: FrameZoomSnapshot = EMPTY_FRAME_ZOOM,
): FrameZoomSnapshot {
  const byId = indexById(nodes);
  const children = new Map<string, Node[]>();
  const contentInsets = new Map<string, number>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    contentInsets.set(
      node.parentId,
      Math.min(contentInsets.get(node.parentId) ?? Infinity, node.position.x),
    );
    if (node.hidden) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const active = new Set<string>();
  const candidates = new Set<string>();
  const fits = new Map<string, boolean>();
  const fallbackFits = new Map<string, boolean>();
  const recovered = new Map<string, boolean>();
  for (const node of nodes) {
    if (node.type !== 'frame' || node.hidden || node.data.contentMissing)
      continue;
    const direct = children.get(node.id);
    if (!direct?.length) continue;
    const size = getNodeSize(node);
    const visual = frameVisualMetricsForSize(size.width, size.height);
    const header = getFrameHeaderMetrics(
      contentInsets.get(node.id) ?? null,
      size.width,
      visual.titleFontSize,
      visual.headerInset,
    );
    const layout = farFrameRegionPresentation(
      size.width * zoom,
      size.height * zoom,
      zoom,
      previous.active.has(node.id),
      header,
    );
    if (layout.active) active.add(node.id);
    fits.set(node.id, layout.visible);
    fallbackFits.set(node.id, layout.fallbackVisible);
    // Recover suppressed inner labels with a little spare space to avoid jitter.
    const margin = previous.suppressed.has(node.id)
      ? FRAME_ZOOM_THRESHOLDS.fitRecoveryMargin
      : 0;
    recovered.set(
      node.id,
      farFrameRegionPresentation(
        size.width * zoom - margin,
        size.height * zoom - margin,
        zoom,
        previous.active.has(node.id),
        header,
      ).visible,
    );
  }
  const demands = new Map<string, boolean>();
  const visiting = new Set<string>();
  const resolveBranch = (id: string): boolean => {
    const cached = demands.get(id);
    if (cached !== undefined) return cached;
    if (!active.has(id) || visiting.has(id)) return false;
    visiting.add(id);
    const childFrames = (children.get(id) ?? []).filter((child) =>
      fits.has(child.id),
    );
    // Visit every branch, even after one fails, so readable siblings remain candidates.
    const childDemands = childFrames.map((child) => resolveBranch(child.id));
    const needsLabel = childFrames.length === 0 || childDemands.some(Boolean);
    let demand = false;
    if (needsLabel) {
      if (recovered.get(id)) candidates.add(id);
      else demand = true;
    }
    visiting.delete(id);
    demands.set(id, demand);
    return demand;
  };
  for (const id of active) resolveBranch(id);
  // If no preferred-fit ancestor can take over, keep a best-effort region
  // rather than leaving the branch blank.
  for (const [id, demand] of demands) {
    if (demand && fallbackFits.get(id)) candidates.add(id);
  }
  const suppressed = new Set<string>();
  const owners = new Map<string, string | undefined>();
  const getOwner = (
    id: string,
    visiting = new Set<string>(),
  ): string | undefined => {
    if (owners.has(id)) return owners.get(id);
    if (visiting.has(id)) return undefined;
    visiting.add(id);
    const parent = byId.get(id)?.parentId;
    const owner =
      parent && byId.has(parent)
        ? (getOwner(parent, visiting) ??
          (candidates.has(parent) ? parent : undefined))
        : undefined;
    owners.set(id, owner);
    return owner;
  };
  const regionZ = new Map<string, number>();
  const regionByNode = new Map<string, string>();
  for (const node of nodes) {
    const owner = getOwner(node.id);
    if (owner) suppressed.add(node.id);
    const region = owner ?? (candidates.has(node.id) ? node.id : undefined);
    if (region) regionByNode.set(node.id, region);
    // CSS z-index requires integers. The viewport portal follows the node layer,
    // so equal-z labels paint after their subtree without covering the next band.
    if (region)
      regionZ.set(
        region,
        Math.max(regionZ.get(region) ?? -Infinity, node.zIndex ?? 0),
      );
  }
  const visible = new Set([...candidates].filter((id) => !suppressed.has(id)));
  return { active, visible, suppressed, regionByNode, regionZ };
}
