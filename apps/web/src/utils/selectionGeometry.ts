// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { Rect, XYPosition } from '@xyflow/react';

export type SelectionArea =
  | { kind: 'rectangle'; rect: Rect }
  | { kind: 'polygon'; points: readonly XYPosition[] };

/** Even-odd fill, shared by node and stroke selection (including self-crossing loops). */
export function isPointInFlowPolygon(
  px: number,
  py: number,
  poly: readonly XYPosition[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.y > py !== b.y > py &&
      px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function onBoundary(point: XYPosition, polygon: readonly XYPosition[]) {
  return polygon.some((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    return (
      (point.x - a.x) * (b.y - a.y) === (point.y - a.y) * (b.x - a.x) &&
      point.x >= Math.min(a.x, b.x) &&
      point.x <= Math.max(a.x, b.x) &&
      point.y >= Math.min(a.y, b.y) &&
      point.y <= Math.max(a.y, b.y)
    );
  });
}

/** Clip a segment against the open rectangle: boundary-only contact is not overlap. */
function segmentEntersRect(a: XYPosition, b: XYPosition, rect: Rect) {
  let lo = 0;
  let hi = 1;
  for (const [start, delta, min, max] of [
    [a.x, b.x - a.x, rect.x, rect.x + rect.width],
    [a.y, b.y - a.y, rect.y, rect.y + rect.height],
  ]) {
    if (delta === 0) {
      if (start <= min || start >= max) return false;
    } else {
      const t1 = (min - start) / delta;
      const t2 = (max - start) / delta;
      lo = Math.max(lo, Math.min(t1, t2));
      hi = Math.min(hi, Math.max(t1, t2));
    }
  }
  return lo < hi;
}

export function selectionHitsRect(
  area: SelectionArea,
  rect: Rect,
  fullyContained: boolean,
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (area.kind === 'rectangle') {
    const outer = area.rect;
    if (outer.width <= 0 || outer.height <= 0) return false;
    return fullyContained
      ? rect.x >= outer.x &&
          rect.y >= outer.y &&
          right <= outer.x + outer.width &&
          bottom <= outer.y + outer.height
      : rect.x < outer.x + outer.width &&
          right > outer.x &&
          rect.y < outer.y + outer.height &&
          bottom > outer.y;
  }

  const polygon = area.points;
  if (polygon.length < 3) return false;
  const a = polygon[0];
  const b = polygon.find((point) => point.x !== a.x || point.y !== a.y);
  if (
    !b ||
    !polygon.some(
      (point) =>
        (point.x - a.x) * (b.y - a.y) !== (point.y - a.y) * (b.x - a.x),
    )
  )
    return false;
  const corners = [
    { x: rect.x, y: rect.y },
    { x: right, y: rect.y },
    { x: right, y: bottom },
    { x: rect.x, y: bottom },
  ];
  const boundaryEnters = polygon.some((a, i) =>
    segmentEntersRect(a, polygon[(i + 1) % polygon.length], rect),
  );
  if (fullyContained) {
    // Corners alone miss concave notches and self-crossing boundaries inside a Frame.
    return (
      !boundaryEnters &&
      corners.every(
        (point) =>
          onBoundary(point, polygon) ||
          isPointInFlowPolygon(point.x, point.y, polygon),
      )
    );
  }
  return (
    boundaryEnters ||
    [
      ...corners,
      { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    ].some(
      (point) =>
        !onBoundary(point, polygon) &&
        isPointInFlowPolygon(point.x, point.y, polygon),
    )
  );
}
