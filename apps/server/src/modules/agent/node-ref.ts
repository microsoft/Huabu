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

import { toSafeFilename } from '../storage/naming.js';

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
 * L1 — adds a representative one-liner.
 *
 * `preview` is the best-available short text picked server-side by
 * the ladder: frontmatter `summary` > `content[:120]` > `data.src`.
 * Treat it as opaque "context"; consumers should not parse it.
 *
 * Used by:
 *  - node-neighbourhood inner nodes
 *  - canvas outline (when the caller opts in to previews)
 */
export interface AgentNodePreview extends AgentNodeRef {
  /** Best-available short text representation; ≤ ~120 chars. */
  preview?: string;
}

/**
 * L2 — adds spatial / hierarchy metadata.
 *
 * `parentFrame` collapses what the canvas stores as `parentId` into
 * an object that carries the parent's display label too — saves the
 * model a second `read` just to learn what frame a node lives in.
 *
 * `position` is in absolute canvas coordinates (already resolved
 * through any parent-frame chain).
 *
 * Used by:
 *  - canvas outline (`get_canvas_outline`)
 *  - inspect_nodes results
 *  - intent-recognition canvas snapshot
 */
export interface AgentNodeOutline extends AgentNodePreview {
  /** Parent frame, when the node lives inside one. */
  parentFrame?: { id: string; label?: string };
  /** Absolute position on canvas (top-left corner). */
  position: { x: number; y: number };
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
  parentFrame?: { id: string; label?: string };
  position: { x: number; y: number };
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
 * Pick the best-available preview string for a node, by ladder:
 * frontmatter `summary` > `content[:120]` > `src`. Returns `undefined`
 * when nothing meaningful is available.
 *
 * The result is always flattened to a single line: node bodies are
 * markdown (headings, list items, blank lines), and a multi-line
 * preview would break any single-line container it is dropped into —
 * most visibly the node-neighbourhood list (`- "label" [type] —
 * <preview>`), where an embedded newline spawns spurious list items /
 * headings. Whitespace runs (including newlines) collapse to one space
 * BEFORE truncation so the 120-char budget is spent on content, not
 * layout.
 *
 * Exported separately from {@link buildAgentNodePreview} so callers
 * that need the bare string (without an enclosing ref) can reuse the
 * exact ladder.
 */
export function extractAgentNodePreview(
  input: NodePreviewInput,
): string | undefined {
  if (typeof input.summary === 'string' && input.summary.trim()) {
    return flattenPreview(input.summary);
  }
  if (typeof input.content === 'string' && input.content.trim()) {
    return flattenPreview(input.content);
  }
  if (typeof input.src === 'string' && input.src.trim()) {
    return input.src.trim();
  }
  return undefined;
}

/** Collapse whitespace to single spaces, then truncate to the cap. */
function flattenPreview(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, NODE_PREVIEW_MAX_LENGTH);
}

/** Build the L1 ref + preview. */
export function buildAgentNodePreview(
  input: NodePreviewInput,
): AgentNodePreview {
  const base = buildAgentNodeRef(input);
  const preview = extractAgentNodePreview(input);
  if (preview) return { ...base, preview };
  return base;
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
    size: input.size,
  };
  if (input.parentFrame) out.parentFrame = input.parentFrame;
  if (input.style) out.style = input.style;
  return out;
}

// ─── Renderers ───────────────────────────────────────────────────────────────

/** Escape a string for safe inclusion in an XML attribute value. */
export function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** Minimum shape {@link renderAgentNodeList} needs to render one node. */
export interface RenderableNode {
  id: string;
  type: string;
  label?: string;
  /** Pre-computed `nodes/<safeLabel>.md`; only emitted when `includeFile`. */
  filename?: string;
  /** Short preview line; emitted as the `preview` attribute when present. */
  preview?: string;
}

/**
 * Render a flat node list into the canonical `<node>` element list the
 * agent sees inside `<selected_nodes>`. The single source of truth for
 * "node list → text", shared by the built-in and external/ACP backends
 * so the two cannot drift.
 *
 * Each node is a metadata-only, self-closing element: `id`, `type`,
 * `label`, optional `file`, and an optional `preview`. The preview is a
 * clearly-named ATTRIBUTE rather than the element body on purpose — a
 * body would invite the model to mistake the ~120-char excerpt for the
 * node's full content. As an attribute it reads as what it is: a scan
 * hint. Callers still tell the model to `read` / `read-node` for the
 * complete body in the surrounding intro.
 *
 * Why `<node>` elements rather than a JSON array or a markdown table:
 *   - previews are free text (flattened, but still arbitrary); a markdown
 *     table cell would break on stray pipes and pretty-JSON wastes tokens
 *     on repeated keys / punctuation;
 *   - the element shape matches the sibling `<skill>` / `<attachment>`
 *     conventions, so the whole prompt reads uniformly.
 *
 * `file` is opt-in because only the built-in agent reads by filename
 * (`read(file)`); the external agent reads by id through the reachback
 * tool (`read-node <id>`), where the virtual `nodes/<file>.md` path would
 * be a misleading dead reference.
 */
export function renderAgentNodeList(
  nodes: readonly RenderableNode[],
  opts: { includeFile?: boolean } = {},
): string {
  const includeFile = opts.includeFile ?? true;
  return nodes
    .map((n) => {
      const preview = n.preview?.trim();
      const attrs = [
        `id="${escapeXmlAttr(n.id)}"`,
        `type="${escapeXmlAttr(n.type)}"`,
        n.label ? `label="${escapeXmlAttr(n.label)}"` : '',
        includeFile && n.filename ? `file="${escapeXmlAttr(n.filename)}"` : '',
        preview ? `preview="${escapeXmlAttr(preview)}"` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<node ${attrs} />`;
    })
    .join('\n');
}
