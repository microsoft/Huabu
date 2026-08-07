// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import { getHeightPolicy } from '../height/policy.js';
import { stripMarkdown } from '../utils/markdown.js';
import { isAlwaysAutoHeightNodeType } from '../utils/nodeSizes.js';

import type { CanvasCommand } from '../../index.js';

type Cmd = Extract<CanvasCommand, { type: 'CHANGE_NODE_TYPE' }>;

/**
 * Convert a node between `text` and `note` types.
 *
 * Both types share a `content: string` field, so the textual payload is
 * preserved across conversions. Note-only metadata (block-level
 * provenance) is stripped when going `note → text` because it has no
 * meaning on a plain text node. Any loss is recoverable via undo.
 *
 * For `note → text`, the Markdown content is also flattened to plain text via
 * `stripMarkdown` — otherwise users would see literal `**bold**` / `# heading`
 * markers in a node that has no Markdown renderer.
 *
 * Sizing: `note` may pin top-level `style.height`; `text` is always
 * content-height and uses `data.style.fontSize` for scale. Conversion preserves
 * width, but drops height whenever the target type is always auto-height.
 *
 * The stored auto-height measurement is dropped unconditionally. A hint
 * proves what it was measured against, and a conversion invalidates that
 * proof in a way the key cannot express: the reference width and the
 * rendering pipeline are properties of the node *type*, deliberately kept
 * out of the key because they are constants — constants of a type the
 * node no longer is. Carrying it across would leave a plausible-looking
 * number that nothing can detect as wrong, and a wrong hint is
 * self-confirming: materializing it produces exactly the height the next
 * measurement would be compared against. Dropping it costs one
 * re-measurement.
 */
const NOTE_ONLY_DATA_KEYS = ['provenance'] as const;

const changeNodeType: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: false,
  },

  handler(cmd, state) {
    const target = state.nodes.find((n) => n.id === cmd.nodeId);
    if (!target) return noop(state, 'not-found');
    if (target.type !== 'text' && target.type !== 'note') {
      return noop(state, 'invalid-target');
    }
    if (target.type === cmd.to) return noop(state);

    const nextNodes = state.nodes.map((n) => {
      if (n.id !== cmd.nodeId) return n;

      const data = { ...((n.data ?? {}) as Record<string, unknown>) };
      data.type = cmd.to;
      // Measured against the source type's reference width and renderer.
      // See the note on the file's doc comment.
      delete data.autoHeight;
      if (cmd.to === 'text') {
        // `text` is always content-driven, so an ownership flag on it is
        // a field `resolveHeightMode` ignores and a later conversion back
        // could misread.
        delete data.heightMode;
        for (const key of NOTE_ONLY_DATA_KEYS) {
          delete data[key];
        }
        // Flatten Markdown to plain text — text nodes don't render Markdown.
        if (typeof data.content === 'string') {
          data.content = stripMarkdown(data.content);
        }
      }

      // Preserve the current visual footprint so the toggle feels seamless.
      // Prefer explicit `style.{width,height}` (user-pinned size); fall back
      // to React Flow's measured dimensions for nodes that were running in
      // auto-size mode. This is critical for `note → text`: a note keeps
      // height implicit, so without an explicit height the new text node
      // collapses to its content's auto-width and visibly mismatches the
      // outer frame.
      const prevStyle = (n.style ?? {}) as {
        width?: number;
        height?: number;
        [k: string]: unknown;
      };
      const measuredWidth =
        typeof n.measured?.width === 'number' ? n.measured.width : undefined;
      const measuredHeight =
        typeof n.measured?.height === 'number' ? n.measured.height : undefined;
      const nextWidth = prevStyle.width ?? measuredWidth;
      const nextHeight = prevStyle.height ?? measuredHeight;
      const targetKeepsHeight = !isAlwaysAutoHeightNodeType(cmd.to);
      const nextStyle = {
        ...prevStyle,
        ...(nextWidth !== undefined ? { width: nextWidth } : {}),
      };
      if (targetKeepsHeight && nextHeight !== undefined) {
        nextStyle.height = nextHeight;
      } else {
        delete nextStyle.height;
      }

      // Record ownership to match the height actually written, rather
      // than leaving `resolveHeightMode` to infer it from the number.
      // The height above was chosen to preserve the visual footprint, and
      // with the hint dropped an `auto` node would materialize to the
      // policy minimum instead — a visible collapse on a conversion whose
      // whole point is that nothing appears to move.
      if (getHeightPolicy(cmd.to).kind === 'toggleable') {
        data.heightMode =
          typeof nextStyle.height === 'number' ? 'fixed' : 'auto';
      }

      return {
        ...n,
        type: cmd.to,
        data,
        style: nextStyle,
      };
    });

    return {
      applied: true,
      nodes: nextNodes,
      edges: state.edges,
    };
  },
};

export default changeNodeType;
