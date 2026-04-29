/**
 * Stage 2a: Shape Classification
 *
 * Classify an annotation cluster's geometric shape using heuristic
 * rules on the raw point data. No ML or LLM needed.
 *
 * Supported shapes:
 *   line   — near-linear stroke (high aspect ratio, low variance)
 *   arrow  — line with a fork/hook at one end
 *   circle — near-closed loop enclosing area
 *   cross  — two roughly perpendicular line segments
 *   scribble — dense back-and-forth strokes (deletion gesture)
 *   other  — none of the above; needs LLM
 */

import type { AnnotationCluster, ShapeClassification } from '@sediment/shared';

// ── Geometry helpers ─────────────────────────────────────────────

interface Pt {
  x: number;
  y: number;
}

function dist(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Total polyline path length. */
function pathLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += dist(pts[i - 1], pts[i]);
  }
  return len;
}

/** R² of linear regression on a set of 2D points. */
function linearR2(pts: Pt[]): number {
  const n = pts.length;
  if (n < 3) return 1;

  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;

  for (const p of pts) {
    sumX += p.x;
    sumY += p.y;
    sumXX += p.x * p.x;
    sumYY += p.y * p.y;
    sumXY += p.x * p.y;
  }

  const meanX = sumX / n;
  const meanY = sumY / n;

  const sxx = sumXX - n * meanX * meanX;
  const syy = sumYY - n * meanY * meanY;
  const sxy = sumXY - n * meanX * meanY;

  if (syy === 0) return 1; // all points at same y — perfectly linear
  if (sxx === 0) return 1; // all points at same x — perfectly linear

  return (sxy * sxy) / (sxx * syy);
}

/**
 * Detect if the tail end of a polyline has a fork/hook (arrow head).
 * Checks if the last ~15% of points reverse direction sharply.
 */
function hasArrowHead(pts: Pt[]): boolean {
  if (pts.length < 10) return false;

  const tailStart = Math.floor(pts.length * 0.85);
  const mainEnd = pts[tailStart];
  const tip = pts[pts.length - 1];

  // Direction of the main stroke body
  const bodyDx = mainEnd.x - pts[0].x;
  const bodyDy = mainEnd.y - pts[0].y;
  const bodyLen = Math.sqrt(bodyDx * bodyDx + bodyDy * bodyDy);
  if (bodyLen < 1) return false;

  // Direction from main body end to tip
  const tailDx = tip.x - mainEnd.x;
  const tailDy = tip.y - mainEnd.y;
  const tailLen = Math.sqrt(tailDx * tailDx + tailDy * tailDy);
  if (tailLen < 1) return false;

  // Angle between body direction and tail direction
  const dot = (bodyDx * tailDx + bodyDy * tailDy) / (bodyLen * tailLen);
  // An arrow head typically reverses at 90-180° → dot product < 0.3
  return dot < 0.3;
}

/**
 * Compute the signed area of a polygon (shoelace formula).
 * Returns the absolute area enclosed by the polygon.
 */
function polygonArea(pts: Pt[]): number {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i].x * pts[j].y;
    area -= pts[j].x * pts[i].y;
  }
  return Math.abs(area) / 2;
}

/**
 * Count the number of direction reversals (sharp turns) in the stroke.
 * A reversal is when the angle between consecutive segments > 120°.
 */
function countReversals(pts: Pt[]): number {
  if (pts.length < 3) return 0;

  // Downsample for noise robustness: take every Nth point
  const step = Math.max(1, Math.floor(pts.length / 40));
  const sampled: Pt[] = [];
  for (let i = 0; i < pts.length; i += step) {
    sampled.push(pts[i]);
  }
  if (sampled.length < 3) return 0;

  let reversals = 0;
  for (let i = 1; i < sampled.length - 1; i++) {
    const dx1 = sampled[i].x - sampled[i - 1].x;
    const dy1 = sampled[i].y - sampled[i - 1].y;
    const dx2 = sampled[i + 1].x - sampled[i].x;
    const dy2 = sampled[i + 1].y - sampled[i].y;

    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    if (len1 < 0.01 || len2 < 0.01) continue;

    const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
    if (dot < -0.5) reversals++; // angle > ~120°
  }

  return reversals;
}

// ── Classifiers ──────────────────────────────────────────────────

function tryLine(pts: Pt[]): ShapeClassification | null {
  if (pts.length < 3) return null;

  const r2 = linearR2(pts);
  if (r2 < 0.85) return null;

  const first = pts[0];
  const last = pts[pts.length - 1];
  const straight = dist(first, last);
  const total = pathLength(pts);

  // Path should not be much longer than the straight-line distance
  if (total > straight * 1.5) return null;

  const isArrow = hasArrowHead(pts);
  const confidence = Math.min(1, r2 * 0.6 + (straight / total) * 0.4);

  return {
    type: isArrow ? 'arrow' : 'line',
    confidence,
    startPoint: { x: first.x, y: first.y },
    endPoint: { x: last.x, y: last.y },
  };
}

function tryCircle(pts: Pt[]): ShapeClassification | null {
  if (pts.length < 8) return null;

  const first = pts[0];
  const last = pts[pts.length - 1];
  const gap = dist(first, last);
  const total = pathLength(pts);

  // Near-closed: gap < 30% of total path length
  if (gap > total * 0.35) return null;

  // Must enclose meaningful area relative to bounding box
  const area = polygonArea(pts);
  const diagonal = total / Math.PI; // rough diameter estimate
  const expectedArea = Math.PI * (diagonal / 2) ** 2;
  const areaRatio = area / Math.max(expectedArea, 1);

  // A circle should fill a reasonable fraction of the expected area
  if (areaRatio < 0.15) return null;

  const closedness = 1 - gap / total;
  const confidence = Math.min(1, closedness * 0.6 + areaRatio * 0.4);

  return { type: 'circle', confidence };
}

function tryCross(pts: Pt[]): ShapeClassification | null {
  // Cross detection: many direction reversals in a compact area
  const reversals = countReversals(pts);
  if (reversals < 2) return null;

  // A cross has 2-4 direction reversals and is relatively compact
  const first = pts[0];
  const last = pts[pts.length - 1];
  const total = pathLength(pts);
  const straight = dist(first, last);

  // Cross strokes are much longer than their straight-line extent
  if (total < straight * 1.8) return null;

  // But not as repetitive as a scribble
  if (reversals > 6) return null;

  const confidence = Math.min(1, 0.5 + reversals * 0.1);
  return { type: 'cross', confidence };
}

function tryScribble(
  pts: Pt[],
  bbox: { width: number; height: number },
): ShapeClassification | null {
  const total = pathLength(pts);
  const diagonal = Math.sqrt(bbox.width ** 2 + bbox.height ** 2);

  if (diagonal < 1) return null;

  // Scribble = very long path crammed into a small bounding box
  const density = total / diagonal;
  if (density < 3) return null;

  // Also expect many direction reversals
  const reversals = countReversals(pts);
  if (reversals < 3) return null;

  const confidence = Math.min(1, 0.3 + density * 0.1 + reversals * 0.05);
  return { type: 'scribble', confidence };
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Classify the shape of an annotation cluster.
 *
 * For multi-stroke clusters, all strokes are merged into a single
 * point sequence for classification. The classifiers are tried in
 * specificity order: line → circle → cross → scribble → other.
 */
export function classifyShape(cluster: AnnotationCluster): ShapeClassification {
  // Merge all strokes into a single point array in flow coordinates
  const allPoints: Pt[] = [];
  for (const stroke of cluster.strokes) {
    for (const pt of stroke.points) {
      // Points are stored relative to the stroke's bounding box origin
      allPoints.push({
        x: stroke.rect.x + pt[0],
        y: stroke.rect.y + pt[1],
      });
    }
  }

  if (allPoints.length < 3) {
    return { type: 'other', confidence: 0 };
  }

  // Try classifiers in specificity order
  const line = tryLine(allPoints);
  if (line && line.confidence > 0.7) return line;

  const circle = tryCircle(allPoints);
  if (circle && circle.confidence > 0.5) return circle;

  const cross = tryCross(allPoints);
  if (cross && cross.confidence > 0.5) return cross;

  const scribble = tryScribble(allPoints, {
    width: cluster.bbox.width,
    height: cluster.bbox.height,
  });
  if (scribble && scribble.confidence > 0.5) return scribble;

  // If a line almost qualified, return it with lower confidence
  if (line && line.confidence > 0.5) return line;
  if (circle && circle.confidence > 0.3) return circle;

  return { type: 'other', confidence: 0 };
}
