import { noop, type CommandDefinition } from './types.js';
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
      if (cmd.to === 'text') {
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
