/**
 * Group consecutive `kind:'tool'` segments in an assistant message
 * so the renderer can emit a single "merged row" per same-kind run.
 *
 * Grouping is keyed by the tool {@link AssistantToolPart.variant}
 * (and, for `agent_tool` parts, the inner `toolName`):
 *  - `agent_tool` parts merge when ADJACENT parts share the same
 *    `toolName`. `MergedAgentToolRow` then renders them as one
 *    collapsible row (e.g. three `inspect_nodes` calls collapse
 *    into "Inspected N nodes").
 *  - `canvas_commands`, `web_search`, and `generic` parts are each
 *    their OWN group — they carry per-call UI (change list, source
 *    list, status card) and merging would lose information.
 *
 * Non-tool segments (text/thinking/plan/status) become singleton
 * groups so the dispatch in `AIMessage` only iterates once.
 */

import type { AssistantSegment } from '../../../store/chatTypes';
import type {
  AgentToolPart,
  AssistantToolPart,
  CanvasCommandsToolPart,
  GenericToolPart,
  WebSearchToolPart,
} from '@sediment/shared';

export type SegmentGroup =
  | { kind: 'segment'; segment: Exclude<AssistantSegment, { kind: 'tool' }> }
  | { kind: 'tool-group'; variant: 'generic'; parts: GenericToolPart[] }
  | {
      kind: 'tool-group';
      variant: 'agent_tool';
      /** Common `toolName` shared by every part in the group. */
      toolName: string;
      parts: AgentToolPart[];
    }
  | {
      kind: 'tool-group';
      variant: 'canvas_commands';
      parts: CanvasCommandsToolPart[];
    }
  | {
      kind: 'tool-group';
      variant: 'web_search';
      parts: WebSearchToolPart[];
    };

/**
 * Per-variant merge key. Adjacent tool parts merge into the same
 * group iff they produce the SAME key (and a non-null key). Returning
 * `null` means "always start a fresh group", i.e. no merging.
 */
function mergeKey(part: AssistantToolPart): string | null {
  switch (part.variant) {
    case 'agent_tool':
      return `agent_tool:${part.toolName}`;
    case 'canvas_commands':
    case 'web_search':
    case 'generic':
      return null;
  }
}

/**
 * Pure helper. Does not look at the assistant message id or any
 * store state — callers carry that through to the renderers.
 */
export function groupAdjacentToolParts(
  segments: AssistantSegment[],
): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    if (seg.kind !== 'tool') {
      groups.push({ kind: 'segment', segment: seg });
      i++;
      continue;
    }
    // Tool segment — try to extend a run of same-key parts.
    const headKey = mergeKey(seg);
    const parts: AssistantToolPart[] = [seg];
    i++;
    if (headKey !== null) {
      while (i < segments.length) {
        const next = segments[i];
        if (next.kind !== 'tool' || mergeKey(next) !== headKey) break;
        parts.push(next);
        i++;
      }
    }
    const headPart = parts[0]!;
    // The merge key guarantees every part in `parts` shares the head
    // part's variant (and `toolName` when `agent_tool`), so the
    // per-variant casts are sound.
    switch (headPart.variant) {
      case 'agent_tool':
        groups.push({
          kind: 'tool-group',
          variant: 'agent_tool',
          toolName: headPart.toolName,
          parts: parts as AgentToolPart[],
        });
        break;
      case 'canvas_commands':
        groups.push({
          kind: 'tool-group',
          variant: 'canvas_commands',
          parts: parts as CanvasCommandsToolPart[],
        });
        break;
      case 'web_search':
        groups.push({
          kind: 'tool-group',
          variant: 'web_search',
          parts: parts as WebSearchToolPart[],
        });
        break;
      case 'generic':
        groups.push({
          kind: 'tool-group',
          variant: 'generic',
          parts: parts as GenericToolPart[],
        });
        break;
    }
  }
  return groups;
}
