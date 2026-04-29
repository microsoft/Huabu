/**
 * Stage 3a: Rule-based Intent Resolver
 *
 * For high-confidence shape classifications with clear target nodes,
 * resolve the annotation intent into a directly-executable list of
 * CanvasCommand objects — no LLM needed.
 *
 * Returns null when the rule engine cannot confidently resolve the intent,
 * signalling that the LLM fallback path should be used.
 */

import { createId } from '@sediment/shared';

import type {
  AnnotationContext,
  ResolvedAnnotationIntent,
} from '@sediment/shared';
import type { CanvasCommand, CanvasNodeId } from '@sediment/shared';

/** Minimum confidence threshold to use the rule engine. */
const RULE_CONFIDENCE_THRESHOLD = 0.6;
/** Maximum distance (px) for an endpoint node to be considered "close enough". */
const ENDPOINT_MAX_DISTANCE = 200;
/** Maximum distance (px) for a deletion stroke near a node. */
const DELETION_NEAR_DISTANCE = 50;

/**
 * Attempt to resolve an annotation intent using deterministic rules.
 */
export function resolveByRules(
  ctx: AnnotationContext,
): ResolvedAnnotationIntent | null {
  const { shape } = ctx;

  if (shape.confidence < RULE_CONFIDENCE_THRESHOLD) return null;

  switch (shape.type) {
    case 'line':
    case 'arrow':
      return resolveLineOrArrow(ctx);
    case 'circle':
      return resolveCircle(ctx);
    case 'cross':
    case 'scribble':
      return resolveDeletion(ctx);
    default:
      return null;
  }
}

function resolveLineOrArrow(
  ctx: AnnotationContext,
): ResolvedAnnotationIntent | null {
  const { startNode, endNode, cluster } = ctx;

  if (
    startNode &&
    endNode &&
    startNode.id !== endNode.id &&
    startNode.distance < ENDPOINT_MAX_DISTANCE &&
    endNode.distance < ENDPOINT_MAX_DISTANCE
  ) {
    const commands: CanvasCommand[] = [
      {
        type: 'CONNECT_NODES',
        edges: [
          {
            source: startNode.id as CanvasNodeId,
            target: endNode.id as CanvasNodeId,
          },
        ],
      },
    ];
    const fromLabel = startNode.label ?? startNode.id;
    const toLabel = endNode.label ?? endNode.id;
    return {
      commands,
      source: 'rule',
      reasoning: `Connect "${fromLabel}" to "${toLabel}"`,
      cluster,
    };
  }

  return null;
}

function resolveCircle(
  ctx: AnnotationContext,
): ResolvedAnnotationIntent | null {
  const { enclosedNodes, cluster } = ctx;

  if (enclosedNodes.length >= 2) {
    const frameId = createId('node') as CanvasNodeId;
    const childIds = enclosedNodes.map((n) => n.id as CanvasNodeId);
    const labels = enclosedNodes.map((n) => n.label ?? n.id).join(', ');

    const commands: CanvasCommand[] = [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: frameId,
            nodeType: 'frame',
            data: { label: 'Group' },
            position: { x: cluster.bbox.x, y: cluster.bbox.y },
            size: {
              width: Math.max(cluster.bbox.width, 200),
              height: Math.max(cluster.bbox.height, 150),
            },
            skipAutoLayout: true,
          },
        ],
      },
      {
        type: 'SET_NODE_PARENT',
        nodeIds: childIds,
        parentId: frameId,
      },
    ];
    return {
      commands,
      source: 'rule',
      reasoning: `Group ${enclosedNodes.length} nodes into a frame: ${labels}`,
      cluster,
    };
  }

  return null;
}

function resolveDeletion(
  ctx: AnnotationContext,
): ResolvedAnnotationIntent | null {
  const { enclosedNodes, nearbyNodes, cluster } = ctx;

  if (enclosedNodes.length > 0) {
    const ids = enclosedNodes.map((n) => n.id as CanvasNodeId);
    const labels = enclosedNodes.map((n) => n.label ?? n.id).join(', ');
    return {
      commands: [{ type: 'DELETE_NODES', nodeIds: ids }],
      source: 'rule',
      reasoning: `Delete ${enclosedNodes.length} node(s): ${labels}`,
      cluster,
    };
  }

  if (
    nearbyNodes.length > 0 &&
    nearbyNodes[0].distance < DELETION_NEAR_DISTANCE
  ) {
    const node = nearbyNodes[0];
    return {
      commands: [{ type: 'DELETE_NODES', nodeIds: [node.id as CanvasNodeId] }],
      source: 'rule',
      reasoning: `Delete node "${node.label ?? node.id}"`,
      cluster,
    };
  }

  return null;
}
