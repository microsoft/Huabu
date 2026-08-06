// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `<node>` element renderer — "node → node prompt".
 *
 * The single source of truth for turning a node reference into the
 * canonical `<node>` element every backend shows the model. Shared by:
 *   - the built-in agent's `<selected_nodes>` block
 *     (`render/selected-nodes.ts`),
 *   - the canvas-neighbourhood `<group>` lists
 *     (`canvas/node-neighbourhood.ts`),
 *   - the external/ACP `<selected_nodes>` block
 *     (`acp/preprocessor.ts`),
 * so the three cannot drift.
 *
 * Output shape (one self-closing element per node):
 *
 *   <node id="n-123" type="note" label="Risks" file="nodes/risks.md" rev="3d7e" summary="FX + supply-chain exposure" preview="Our top risks this quarter are…" />
 *   <node id="n-456" type="image" file="nodes/diagram.md" />
 *
 * Each element is metadata only:
 *   - `id`      — always; the addressable handle.
 *   - `type`    — always; the canvas node type.
 *   - `label`   — when the node has one.
 *   - `file`    — the pre-computed `nodes/<file>.md` path, when the node has
 *                 one. Both backends address a node by this path (the
 *                 built-in agent `read()`s it; the external agent downloads
 *                 it over the RFS).
 *   - `rev`     — content revision token, when the node has a body / src.
 *   - `summary` — the authored abstract (frontmatter `summary`), when present.
 *   - `preview` — a raw body excerpt (`content[:120]`), when present. `summary`
 *                 and `preview` are INDEPENDENT named attributes (a curated
 *                 abstract vs a raw peek); either / both / neither may appear.
 *                 Deliberately named attributes, not the element body, so the
 *                 model cannot mistake them for the node's full content —
 *                 callers tell it to `read` for the complete body.
 *
 * Kept out of `node-ref.ts` (which owns the pure data ladder) so the
 * prompt-text concern lives next to the other section renderers under
 * `prompt/`.
 */

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

/**
 * Escape a string for safe inclusion as XML element *body* text. Unlike
 * {@link escapeXmlAttr} this preserves newlines, so a multi-line excerpt
 * inlined between `<attachment>…</attachment>` keeps its formatting while
 * stray `&`/`<`/`>` (e.g. a literal `</attachment>` in the content) can no
 * longer break out of or inject into the surrounding tag structure.
 */
export function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Minimum shape {@link renderNodes} needs to render one node. */
export interface RenderableNode {
  id: string;
  type: string;
  label?: string;
  /** Pre-computed `nodes/<safeLabel>.md`; emitted as `file=` when present. */
  filename?: string;
  /** Authored abstract (frontmatter `summary`); emitted as `summary=`. */
  summary?: string;
  /** Raw body excerpt; emitted as the `preview` attribute when present. */
  preview?: string;
  /**
   * Revision token over authored content; emitted as the `rev` attribute so
   * the model can compare it against the rev it read earlier (RFS `ETag` /
   * a prior turn) and re-read only when it differs.
   */
  rev?: string;
}

/**
 * Render a flat node list into the canonical `<node>` element list (one
 * self-closing element per line). See the file header for the output
 * shape and the per-attribute rules.
 *
 * Why `<node>` elements rather than a JSON array or a markdown table:
 *   - previews are free text (flattened, but still arbitrary); a markdown
 *     table cell would break on stray pipes and pretty-JSON wastes tokens
 *     on repeated keys / punctuation;
 *   - the element shape matches the sibling `<skill>` / `<attachment>`
 *     conventions, so the whole prompt reads uniformly.
 */
export function renderNodes(nodes: readonly RenderableNode[]): string {
  return nodes
    .map((n) => {
      const summary = n.summary?.trim();
      const preview = n.preview?.trim();
      const attrs = [
        `id="${escapeXmlAttr(n.id)}"`,
        `type="${escapeXmlAttr(n.type)}"`,
        n.label ? `label="${escapeXmlAttr(n.label)}"` : '',
        n.filename ? `file="${escapeXmlAttr(n.filename)}"` : '',
        n.rev ? `rev="${escapeXmlAttr(n.rev)}"` : '',
        summary ? `summary="${escapeXmlAttr(summary)}"` : '',
        preview ? `preview="${escapeXmlAttr(preview)}"` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<node ${attrs} />`;
    })
    .join('\n');
}
