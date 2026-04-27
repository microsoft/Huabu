/**
 * Stage 3a: Rule-based Intent Resolver
 *
 * For high-confidence shape classifications with clear target nodes,
 * resolve the annotation intent using deterministic rules — no LLM needed.
 *
 * Returns null when the rule engine cannot confidently resolve the intent,
 * signalling that the LLM fallback path should be used.
 */

import { rectCenter } from '@sediment/shared';

import type { AnnotationContext, ResolvedAnnotationIntent } from './types';

/** Minimum confidence threshold to use the rule engine. */
const RULE_CONFIDENCE_THRESHOLD = 0.6;
/** Maximum distance (px) for an endpoint node to be considered "close enough". */
const ENDPOINT_MAX_DISTANCE = 200;

/**
 * Attempt to resolve an annotation intent using deterministic rules.
 *
 * @returns A resolved intent, or `null` if LLM fallback is needed.
 */
export function resolveByRules(
  ctx: AnnotationContext,
): ResolvedAnnotationIntent | null {
  const { shape, cluster } = ctx;

  if (shape.confidence < RULE_CONFIDENCE_THRESHOLD) return null;

  const center = rectCenter(cluster.bbox);
  const position = { x: Math.round(center.x), y: Math.round(center.y) };

  switch (shape.type) {
    case 'line':
    case 'arrow':
      return resolveLineOrArrow(ctx, position);
    case 'circle':
      return resolveCircle(ctx, position);
    case 'cross':
    case 'scribble':
      return resolveDeletion(ctx, position);
    default:
      return null;
  }
}

// ── Shape-specific resolvers ─────────────────────────────────────

function resolveLineOrArrow(
  ctx: AnnotationContext,
  position: { x: number; y: number },
): ResolvedAnnotationIntent | null {
  const { startNode, endNode, cluster } = ctx;

  // Need two distinct endpoint nodes to create a connection
  if (
    startNode &&
    endNode &&
    startNode.id !== endNode.id &&
    startNode.distance < ENDPOINT_MAX_DISTANCE &&
    endNode.distance < ENDPOINT_MAX_DISTANCE
  ) {
    const fromLabel = startNode.label ? `"${startNode.label}"` : startNode.id;
    const toLabel = endNode.label ? `"${endNode.label}"` : endNode.id;
    return {
      label: `Connect ${fromLabel} (${startNode.id}) to ${toLabel} (${endNode.id})`,
      source: 'rule',
      cluster,
      position,
    };
  }

  // Single endpoint near a node — could be a pointer/highlight, let LLM decide
  return null;
}

function resolveCircle(
  ctx: AnnotationContext,
  position: { x: number; y: number },
): ResolvedAnnotationIntent | null {
  const { enclosedNodes, nearbyNodes, cluster } = ctx;

  // Circle enclosing multiple nodes → group into frame
  if (enclosedNodes.length >= 2) {
    const ids = enclosedNodes.map((n) => n.id);
    const labels = enclosedNodes
      .map((n) => (n.label ? `"${n.label}"` : n.id))
      .join(', ');
    return {
      label: `Group nodes [${ids.join(', ')}] (${labels}) into a new frame`,
      source: 'rule',
      cluster,
      position,
    };
  }

  // Circle around a single node — could be emphasis or selection
  if (enclosedNodes.length === 1) {
    const node = enclosedNodes[0];
    const label = node.label ? `"${node.label}"` : node.id;
    return {
      label: `Expand or elaborate on ${label} (${node.id})`,
      source: 'rule',
      cluster,
      position,
    };
  }

  // Circle in empty area with nearby nodes — might mean "add something here"
  if (nearbyNodes.length > 0) {
    return null; // Let LLM decide
  }

  return null;
}

function resolveDeletion(
  ctx: AnnotationContext,
  position: { x: number; y: number },
): ResolvedAnnotationIntent | null {
  const { enclosedNodes, nearbyNodes, cluster } = ctx;

  // Cross/scribble directly over a node → delete
  if (enclosedNodes.length > 0) {
    const ids = enclosedNodes.map((n) => n.id);
    const labels = enclosedNodes
      .map((n) => (n.label ? `"${n.label}"` : n.id))
      .join(', ');
    return {
      label: `Delete node(s) [${ids.join(', ')}] (${labels})`,
      source: 'rule',
      cluster,
      position,
    };
  }

  // Cross/scribble near (but not over) a node — check if very close
  if (nearbyNodes.length > 0 && nearbyNodes[0].distance < 50) {
    const node = nearbyNodes[0];
    const label = node.label ? `"${node.label}"` : node.id;
    return {
      label: `Delete node ${node.id} (${label})`,
      source: 'rule',
      cluster,
      position,
    };
  }

  return null;
}
