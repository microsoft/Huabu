/**
 * LLM-facing node reference ladder + builders.
 *
 * Server-only. The wire layer (`@sediment/shared`'s `WireNodeRef` /
 * `WireSelectionNode` / `WireCanvasNode`) carries raw canvas state
 * across the network; this module owns the *prompt-shaped*
 * enrichments — pre-computed `nodes/<safeLabel>.md` filename, picked
 * preview line, parent-frame label lookup — that the model actually
 * sees.
 *
 * Kept out of `@sediment/shared` because:
 *   - the web bundle never sends `filename` / `preview` /
 *     `parentFrame.label` to the server, so it has no reason to compute
 *     them or even know they exist;
 *   - changing the prompt shape (preview length, filename rule,
 *     opt-in fields) should not require a frontend deploy.
 *
 * Replaces the four parallel implementations of "compute filename +
 * pick a preview line" that previously lived in:
 *   - agent.route.ts (selected nodes)
 *   - sketch.service.ts (sketch refs)
 *   - canvas/canvas-spatial.ts (outline)
 *   - canvas/node-neighbourhood.ts (neighbourhood)
 *
 * Builders are pure functions: every input the builder needs is
 * passed in. No filesystem access, no canvas store access. Adapters
 * higher up (`buildSpatialBundle`, etc.) gather the raw fields and
 * forward them here.
 */

import { nodeRevisionOf } from '@sediment/shared/canvas-engine';

import { toSafeFilename } from '../workspace/disk/naming.js';

import type { CanvasNodeType, WireNodeRef } from '@sediment/shared';

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * L0 — minimum addressable form for the LLM.
 *
 * `filename` is pre-computed server-side as `nodes/<safeLabel>.md`
 * so the model can pass it straight to `read` without re-deriving
 * the `safeLabel` rule (a frequent source of 404'd reads). Falls
 * back to `nodes/<id>.md` for label-less nodes.
 *
 * Used by:
 *  - selected-node preamble (chat agent)
 *  - sketch cluster nearby/enclosed lists
 *  - any future "here is a node, do something with it" injection
 */
export interface AgentNodeRef extends WireNodeRef {
  /** Pre-computed `nodes/<safeLabel>.md`; pass straight to `read`. */
  filename: string;
}

/**
 * L1 — adds representative short text.
 *
 * Two INDEPENDENT one-liners, so the model can tell a curated abstract
 * from a raw peek:
 *   - `summary` — the frontmatter `summary` (an authored / generated
 *     abstract of the node), when present.
 *   - `preview` — a raw excerpt of the body (`content[:120]`), when present.
 * A node may carry either, both, or neither. Treat each as opaque
 * "context"; consumers should not parse them.
 *
 * Used by:
 *  - node-neighbourhood inner nodes
 *  - canvas outline (when the caller opts in to previews)
 */
export interface AgentNodePreview extends AgentNodeRef {
  /** Frontmatter `summary` (authored abstract); ≤ ~120 chars. */
  summary?: string;
  /** Raw body excerpt (`content[:120]`); ≤ ~120 chars. */
  preview?: string;
  /**
   * Revision token over the node's authored content (`content` / `src`),
   * matching the `ETag` an RFS download returns. Lets the model compare "the
   * rev I read earlier" against "the rev shown this turn" and re-read only when
   * they differ. Absent for nodes with no authored body (e.g. frames).
   */
  rev?: string;
}

/**
 * L2 — adds spatial / hierarchy metadata.
 *
 * `parentFrame` collapses what the canvas stores as `parentId` into
 * an object that carries the parent's display label too — saves the
 * model a second `read` just to learn what frame a node lives in.
 *
 * Coordinates use a local-vs-world split:
 *   - `position` is **parent-local** — relative to the direct parent
 *     frame, or absolute for a root node (no parent). This is the value
 *     the agent echoes back when creating / moving a node.
 *   - `absolutePosition` is the **world** coordinate (parent-chain
 *     resolved), read-only, for proximity / global-layout reasoning.
 *
 * Used by:
 *  - canvas outline (`get_canvas_outline`)
 *  - inspect_nodes results
 */
export interface AgentNodeOutline extends AgentNodePreview {
  /** Cross-Space address exposed by a World canvasRef. */
  targetCanvasId?: string;
  /** Persistent source identity exposed by a World nodeRef. */
  target?: { canvasId: string; nodeId: string };
  /** Parent frame, when the node lives inside one. */
  parentFrame?: { id: string; label?: string };
  /**
   * Parent-local top-left: relative to the direct parent frame, or
   * absolute when the node has no parent. This is the sole writable
   * coordinate — echo it back on `CREATE_NODES` / `SET_NODE_GEOMETRY`.
   */
  position: { x: number; y: number };
  /**
   * World top-left (parent-chain resolved). Read-only; for proximity /
   * global-layout reasoning. Equals `position` for a root node.
   */
  absolutePosition: { x: number; y: number };
  /** Effective dimensions (measured > styled > 0 fallback). */
  size: { width: number; height: number };
  /**
   * Visual style on `data.style`; only emitted when the caller opts
   * in (e.g. `get_canvas_outline({ includeStyle: true })`).
   */
  style?: Record<string, unknown>;
}

// ─── Inputs ────────────────────────────────────────────────────────────────

/**
 * Just enough to build an {@link AgentNodeRef}: identity + type + label.
 * No content, no geometry, no parent.
 */
export interface NodeRefInput {
  id: string;
  type: CanvasNodeType;
  label?: string;
  targetCanvasId?: string;
  target?: { canvasId: string; nodeId: string };
}

/**
 * {@link NodeRefInput} + the raw fields needed to pick a preview line.
 * The builder applies the ladder; callers just hand it whatever they
 * have (any subset of `summary` / `content` / `src`).
 */
export interface NodePreviewInput extends NodeRefInput {
  /** Frontmatter `summary` from `nodes/<file>.md`, when available. */
  summary?: string;
  /** Inline node body text (markdown / plain text). */
  content?: string;
  /** Source URL — meaningful for image / pdf / web / video nodes. */
  src?: string;
}

/**
 * {@link NodePreviewInput} + spatial / hierarchy fields for outline-level
 * payloads. `position` and `size` are required because every outline
 * consumer needs them; everything else is optional.
 */
export interface NodeOutlineInput extends NodePreviewInput {
  targetCanvasId?: string;
  target?: { canvasId: string; nodeId: string };
  parentFrame?: { id: string; label?: string };
  position: { x: number; y: number };
  /**
   * World coordinate (parent-chain resolved). Optional on input;
   * callers that know only a single coordinate space (e.g. a root node)
   * may omit it and it defaults to `position`.
   */
  absolutePosition?: { x: number; y: number };
  size: { width: number; height: number };
  style?: Record<string, unknown>;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * Maximum length of the auto-truncated content slice fallback in
 * {@link extractAgentNodePreview}. Matches the historical 120-char
 * limit used by the per-call ad-hoc implementations.
 */
export const NODE_PREVIEW_MAX_LENGTH = 120;

// ─── Builders ──────────────────────────────────────────────────────────────

/**
 * Build the L0 reference. Pre-computes
 * `nodes/<safeLabel>.md` so the LLM can hand it straight to `read`.
 */
export function buildAgentNodeRef(input: NodeRefInput): AgentNodeRef {
  const ref: AgentNodeRef = {
    id: input.id,
    type: input.type,
    filename: `nodes/${toSafeFilename(input.label, input.id)}.md`,
  };
  if (input.label) ref.label = input.label;
  return ref;
}

/**
 * The raw body excerpt for a node's `preview` field: `content[:120]`,
 * flattened to a single line. Returns `undefined` when there is no body.
 * `summary` is NOT consulted here (it is its own {@link AgentNodePreview}
 * field), and `src` is deliberately not a fallback (a bare URL is not a
 * content preview; media nodes are read via snapshot / their `src` field).
 *
 * The result is always flattened to a single line: node bodies are
 * markdown (headings, list items, blank lines), and a multi-line
 * preview would break any single-line container it is dropped into.
 * Whitespace runs (including newlines) collapse to one space BEFORE
 * truncation so the 120-char budget is spent on content, not layout.
 *
 * Exported separately from {@link buildAgentNodePreview} so callers that
 * need the bare excerpt (without an enclosing ref) can reuse it.
 */
export function extractAgentNodePreview(
  input: NodePreviewInput,
): string | undefined {
  if (typeof input.content === 'string' && input.content.trim()) {
    return flattenPreview(input.content);
  }
  return undefined;
}

/** Collapse whitespace to single spaces, then truncate to the cap. */
function flattenPreview(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, NODE_PREVIEW_MAX_LENGTH);
}

/**
 * Revision token for a preview input, over its authored content
 * (`content` / `src`) — the SAME `nodeRevision` the RFS `ETag` uses.
 * Returns `undefined` when the input carries no body/src to hash (e.g. a
 * frame, or a ref built from metadata only), so the caller omits `rev`.
 *
 * `content` must be the canonical body (on-disk `nodes/<label>.md` for note
 * nodes, inline `data.content` for text-on-canvas nodes) — the same value the
 * ladder above consumes — so the `rev` here matches the `ETag` a download of
 * the same node would return.
 */
function revisionOfPreviewInput(input: NodePreviewInput): string | undefined {
  if (typeof input.content !== 'string' && typeof input.src !== 'string') {
    return undefined;
  }
  return nodeRevisionOf({ content: input.content, src: input.src });
}

/** Build the L1 ref + preview. */
export function buildAgentNodePreview(
  input: NodePreviewInput,
): AgentNodePreview {
  const out: AgentNodePreview = buildAgentNodeRef(input);
  if (typeof input.summary === 'string' && input.summary.trim()) {
    out.summary = flattenPreview(input.summary);
  }
  const preview = extractAgentNodePreview(input);
  if (preview) out.preview = preview;
  const rev = revisionOfPreviewInput(input);
  if (rev) out.rev = rev;
  return out;
}

/**
 * Build the L2 ref + preview + spatial / hierarchy metadata.
 */
export function buildAgentNodeOutline(
  input: NodeOutlineInput,
): AgentNodeOutline {
  const base = buildAgentNodePreview(input);
  const out: AgentNodeOutline = {
    ...base,
    position: input.position,
    absolutePosition: input.absolutePosition ?? input.position,
    size: input.size,
  };
  if (input.parentFrame) out.parentFrame = input.parentFrame;
  if (input.style) out.style = input.style;
  if (input.targetCanvasId) out.targetCanvasId = input.targetCanvasId;
  if (input.target) out.target = input.target;
  return out;
}
