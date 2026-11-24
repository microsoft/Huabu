// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
} from '@xyflow/system';

import type { EdgeLineType } from '../../index.js';

export function getEdgeLineType(
  data?: Record<string, unknown>,
  legacyType?: string,
): EdgeLineType {
  const style = data?.edgeStyle;
  if (style && typeof style === 'object' && 'lineType' in style) {
    const type = style.lineType;
    if (type === 'straight' || type === 'step' || type === 'bezier')
      return type;
  }
  return legacyType === 'straight'
    ? 'straight'
    : legacyType === 'smoothstep' || legacyType === 'step'
      ? 'step'
      : 'bezier';
}

/** Shared with the renderer so route selection evaluates the same geometry. */
export function getEdgePath(
  params: Parameters<typeof getBezierPath>[0],
  lineType: EdgeLineType = 'bezier',
) {
  if (lineType === 'straight') return getStraightPath(params);
  if (lineType === 'step') return getSmoothStepPath(params);
  return getBezierPath(params);
}

export interface PathPoint {
  x: number;
  y: number;
}

/** Fixed routing-only budget; rendering still uses the original smooth path. */
const CURVE_SEGMENTS = 8;

function flattenCurve(curve: PathPoint[], points: PathPoint[]): void {
  const [a, b, c, d] = curve;
  for (let i = 1; i <= CURVE_SEGMENTS; i++) {
    const t = i / CURVE_SEGMENTS;
    const u = 1 - t;
    points.push(
      d
        ? {
            x:
              u * u * u * a.x +
              3 * u * u * t * b.x +
              3 * u * t * t * c.x +
              t * t * t * d.x,
            y:
              u * u * u * a.y +
              3 * u * u * t * b.y +
              3 * u * t * t * c.y +
              t * t * t * d.y,
          }
        : {
            x: u * u * a.x + 2 * u * t * b.x + t * t * c.x,
            y: u * u * a.y + 2 * u * t * b.y + t * t * c.y,
          },
    );
  }
}

/**
 * Approximate React Flow's absolute M/L/Q/C primitives for route scoring.
 * Each curve gets eight segments regardless of length or curvature; small
 * obstacles and endpoint re-entry between samples may be missed deliberately.
 * This is not an arbitrary SVG parser; fail explicitly if that contract changes.
 */
export function flattenEdgePath(path: string): PathPoint[] {
  const tokens = path.match(/[a-zA-Z]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/g) ?? [];
  const points: PathPoint[] = [];
  let index = 0;
  const readPoint = (): PathPoint => {
    const x = Number(tokens[index++]);
    const y = Number(tokens[index++]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('Invalid coordinates in generated edge path');
    }
    return { x, y };
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M' || command === 'L') {
      points.push(readPoint());
    } else if ((command === 'Q' || command === 'C') && points.length > 0) {
      const curve = [points[points.length - 1], readPoint(), readPoint()];
      if (command === 'C') curve.push(readPoint());
      flattenCurve(curve, points);
    } else {
      throw new Error(`Unsupported generated edge path command: ${command}`);
    }
  }
  return points;
}
