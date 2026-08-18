// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Pure "node → context" assembly.
 *
 * ONE rule: a node is carried into the prompt with whatever authored info
 * the caller already has; anything missing (label / body / summary / src)
 * is filled from the node's canonical structured record.
 * Topology never persists `data.label` or note bodies, so a
 * caller that only has the raw canvas node hands in almost nothing and the
 * node record supplies the rest. This is the single place assembly lives, so
 * every server-side path (selection / neighbourhood / outline / inspect)
 * produces the same `label / file / preview / rev` and cannot drift.
 *
 * Two public entry points:
 *   - {@link describeNode} — node → the LLM-facing data object, at the
 *     `'preview'` or `'outline'` level. Both levels always carry `rev`
 *     (freshness / CAS); the rev-less L0 `ref` shape is NOT agent-facing.
 *   - {@link renderNodes} (re-exported) — the object → `<node .../>` XML
 *     translator. JSON tool results (outline / inspect) skip it.
 *
 * The pure ladder (`buildAgentNodePreview` / `buildAgentNodeOutline`) stays
 * in `agent/node-ref.ts` and owns the filename rule / preview ladder / rev
 * hash; callers own the one storage read that feeds it.
 */

import {
  buildAgentNodeOutline,
  buildAgentNodePreview,
} from '../agent/node-ref.js';

import type { NodeContent } from './persistence-types.js';
import type { AgentNodeOutline, AgentNodePreview } from '../agent/node-ref.js';
import type { CanvasNodeType } from '@huabu/shared';

export { renderNodes } from '../agent/conversation/prompt/node-element.js';

/**
 * Whatever the caller already knows about a node. Only `id` is required;
 * every other field is optional and, when absent, is filled from the
 * node record by {@link describeNode}. `position` / `size` (and the optional
 * `parentFrame` / `style`) are only consumed at the `'outline'` level.
 */
export interface NodeInput {
  id: string;
  type?: string;
  label?: string;
  summary?: string;
  content?: string;
  src?: string;
  position?: { x: number; y: number };
  /** World coordinate; when omitted the outline builder defaults it to `position`. */
  absolutePosition?: { x: number; y: number };
  size?: { width: number; height: number };
  parentFrame?: { id: string; label?: string };
  style?: Record<string, unknown>;
  targetCanvasId?: string;
  target?: { canvasId: string; nodeId: string };
}

/** Agent-facing node shapes. `'ref'` (no rev) is deliberately excluded. */
export type NodeLevel = 'preview' | 'outline';

/** Prefer the caller's own value; fall back to the sidecar's. */
function pick(own: unknown, fromRecord: unknown): string | undefined {
  if (typeof own === 'string' && own.trim()) return own;
  return typeof fromRecord === 'string' && fromRecord ? fromRecord : undefined;
}

/**
 * Merge the caller's authored fields with a pre-read node record (own wins).
 * Pass `null` when the node has no canonical content record.
 */
function authoredFields(
  input: NodeInput,
  meta: NodeContent | null = null,
): { label?: string; summary?: string; content?: string; src?: string } {
  const m = meta;
  const out: {
    label?: string;
    summary?: string;
    content?: string;
    src?: string;
  } = {};
  const label = pick(input.label, m?.label);
  if (label !== undefined) out.label = label;
  const summary = pick(
    input.summary,
    (m as Record<string, unknown> | null)?.['summary'],
  );
  if (summary !== undefined) out.summary = summary;
  const content = pick(input.content, m?.content);
  if (content !== undefined) out.content = content;
  const src = pick(input.src, m?.src);
  if (src !== undefined) out.src = src;
  return out;
}

/**
 * Node → LLM-facing data object at the requested `level`. Carries the
 * caller's authored fields and fills any gaps from the node record; always
 * emits `rev` for content-bearing nodes (the freshness / CAS token).
 * When `meta` is absent only the caller's own fields are used.
 */
export function describeNode(
  input: NodeInput,
  level: 'preview',
  meta?: NodeContent | null,
): AgentNodePreview;
export function describeNode(
  input: NodeInput,
  level: 'outline',
  meta?: NodeContent | null,
): AgentNodeOutline;
export function describeNode(
  input: NodeInput,
  level: NodeLevel,
  meta?: NodeContent | null,
): AgentNodePreview | AgentNodeOutline {
  const common = {
    id: input.id,
    type: (input.type ?? 'note') as CanvasNodeType,
    ...authoredFields(input, meta),
  };
  if (level === 'outline') {
    return buildAgentNodeOutline({
      ...common,
      position: input.position ?? { x: 0, y: 0 },
      ...(input.absolutePosition
        ? { absolutePosition: input.absolutePosition }
        : {}),
      size: input.size ?? { width: 0, height: 0 },
      ...(input.parentFrame ? { parentFrame: input.parentFrame } : {}),
      ...(input.style ? { style: input.style } : {}),
      ...(input.targetCanvasId ? { targetCanvasId: input.targetCanvasId } : {}),
      ...(input.target ? { target: input.target } : {}),
    });
  }
  return buildAgentNodePreview(common);
}

/**
 * Resolve just a node's display label from its pre-read record. Used for the
 * parent-frame `label=` hint — a plain string, not an agent-facing node,
 * so it needs no rev.
 */
export function nodeLabel(
  meta: NodeContent | null | undefined,
): string | undefined {
  return typeof meta?.label === 'string' && meta.label ? meta.label : undefined;
}
