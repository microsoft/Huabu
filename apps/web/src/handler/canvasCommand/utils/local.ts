// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Web-only canvas command helpers.
 *
 * These helpers depend on web-side shapes (NodeRef, NodeEditDiff,
 * RecentAction) or on ReactFlow's runtime conventions (`node.style`),
 * so they intentionally live outside the shared canvas-engine.
 *
 * The barrel `./index.ts` re-exports everything here alongside the
 * pure helpers from `@huabu/shared/canvas-engine`, so call sites
 * keep importing from `'@/handler/canvasCommand/utils'` regardless of
 * where each function actually lives.
 */

import {
  findFrameAtPoint,
  getAbsolutePosition,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import type {
  CanvasNodeType,
  NodeEditDiff,
  NodeEditOp,
  NodeRef,
  NodeSize,
  RecentAction,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

/** Extract a lightweight NodeRef from a ReactFlow node. */
export function extractNodeRef(node: Node): NodeRef {
  const label = node.data?.label;
  return {
    id: node.id,
    type: (node.type ?? 'note') as CanvasNodeType,
    ...(typeof label === 'string' ? { label } : {}),
    origin: (node.data as Record<string, unknown> | undefined)
      ?.origin as NodeRef['origin'],
  };
}

/**
 * Extract a short text snippet from a node — first 120 chars of content for
 * note/text nodes, or the src URL for media nodes.
 */
export function extractSnippet(node: Node): string | undefined {
  const data = node.data as Record<string, unknown> | undefined;
  if (!data) return undefined;
  if (
    node.type === 'web' ||
    node.type === 'pdf' ||
    node.type === 'office' ||
    node.type === 'video' ||
    node.type === 'image'
  ) {
    return data.src as string | undefined;
  }
  const content = data.content;
  if (typeof content === 'string' && content.length > 0) {
    return content.slice(0, 120);
  }
  return undefined;
}

// ── Edit diff classification ────────────────────────────────────────────

const TWEAK_RATIO = 0.2;

/**
 * Classify a text edit by comparing before/after strings, using cheap
 * prefix / suffix / substring checks (no LCS). Returns a `NodeEditOp`
 * tag that captures the *shape* of the edit — which is what the agent
 * needs to recognise patterns like "user is appending evidence" vs
 * "user is rewriting the whole node".
 *
 * Rules, in priority order:
 *  1. empty → non-empty   = `create`
 *  2. non-empty → empty   = `clear`
 *  3. after starts-with before  = `append`
 *  4. after ends-with before    = `prepend`
 *  5. after contains before     = `insert`
 *  6. before starts-with after  = `trim_tail`
 *  7. before contains after     = `trim`
 *  8. length change < 20%       = `tweak`
 *  9. otherwise                 = `rewrite`
 */
function classifyEdit(before: string, after: string): NodeEditOp {
  if (before.length === 0 && after.length > 0) return 'create';
  if (after.length === 0) return 'clear';
  if (after.startsWith(before)) return 'append';
  if (after.endsWith(before)) return 'prepend';
  if (after.includes(before)) return 'insert';
  if (before.startsWith(after)) return 'trim_tail';
  if (before.includes(after)) return 'trim';
  const denom = Math.max(before.length, 1);
  const ratio = Math.abs(after.length - before.length) / denom;
  return ratio < TWEAK_RATIO ? 'tweak' : 'rewrite';
}

/**
 * Build a `NodeEditDiff` summary from raw before/after text. Returns
 * `undefined` when either side is not a string or the content is
 * unchanged — `node_edited` is then logged without a diff body.
 *
 * Note: `charsAdded` / `charsRemoved` are net counts derived from
 * length only; they are lower bounds on the true insertion / deletion
 * volume but are stable and free to compute.
 */
export function computeNodeEditDiff(
  before: unknown,
  after: unknown,
): NodeEditDiff | undefined {
  if (typeof before !== 'string' || typeof after !== 'string') return undefined;
  if (before === after) return undefined;
  const beforeLen = before.length;
  const afterLen = after.length;
  return {
    op: classifyEdit(before, after),
    beforeLen,
    afterLen,
    charsAdded: Math.max(0, afterLen - beforeLen),
    charsRemoved: Math.max(0, beforeLen - afterLen),
  };
}

/** Append an action to the ring buffer, capping at ACTION_HISTORY_MAX. */
export function pushAction(
  history: RecentAction[],
  action: RecentAction,
  max = 10,
): RecentAction[] {
  const next = [...history, action];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Extract a CanvasSize from a ReactFlow node's inline style. */
export function canvasSizeFromStyle(
  style: Node['style'] | undefined,
): NodeSize | undefined {
  const styleRecord = style as Record<string, unknown> | undefined;
  const width = styleRecord?.width;
  if (typeof width !== 'number') return undefined;

  const height = styleRecord?.height;
  return typeof height === 'number' ? { width, height } : { width };
}

/** Return the IDs of all selected nodes. */
export function getSelectedNodeIds(
  nodes: { id: string; selected?: boolean }[],
): string[] {
  return nodes.filter((n) => n.selected).map((n) => n.id);
}

/**
 * Hit-test a point against all frame nodes. If a frame is found,
 * returns its id and absolute position (for coordinate adjustment).
 */
export function resolveFrameAtPoint(
  nodes: NestableNode[],
  point: { x: number; y: number },
): { parentId: string; absolutePosition: { x: number; y: number } } | null {
  const frameId = findFrameAtPoint(nodes, point);
  if (!frameId) return null;
  const frameAbs = getAbsolutePosition(nodes, frameId);
  if (!frameAbs) return null;
  return { parentId: frameId, absolutePosition: frameAbs };
}
