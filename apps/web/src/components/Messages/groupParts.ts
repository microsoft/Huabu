/**
 * Group consecutive `kind:'tool'` segments in an assistant message
 * so the renderer can emit a single "merged row" per same-kind run.
 *
 * Grouping key:
 *  - For internal-agent tools (`internalToolName` set), adjacent
 *    parts with the SAME `internalToolName` group together — the
 *    existing `MergedAgentToolRow` / `CanvasCommandCard` already
 *    expect this. Mixed internal names break the group.
 *  - For ACP-native tools (no `internalToolName`), each tool part
 *    is its own group — `ToolCallCard` renders one card per call
 *    and merging would lose information.
 *
 * Non-tool segments (text/thinking/plan/status) become singleton
 * groups so the dispatch in `AIMessage` only iterates once.
 */

import type { AssistantSegment } from '../../store/chatTypes';
import type { AssistantToolPart } from '@sediment/shared';

export type SegmentGroup =
  | { kind: 'segment'; segment: Exclude<AssistantSegment, { kind: 'tool' }> }
  | {
      kind: 'tool-group';
      /** Common `internalToolName` for internal groups; `undefined` for ACP-native. */
      internalToolName: AssistantToolPart['internalToolName'] | undefined;
      /** One or more adjacent tool parts. */
      parts: AssistantToolPart[];
    };

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
    // Tool segment — try to extend a run of same-kind parts.
    const internalToolName = seg.internalToolName;
    const parts: AssistantToolPart[] = [seg];
    i++;
    // ACP-native parts (no internalToolName) never merge.
    if (internalToolName !== undefined) {
      while (i < segments.length) {
        const next = segments[i];
        if (
          next.kind !== 'tool' ||
          next.internalToolName !== internalToolName
        ) {
          break;
        }
        parts.push(next);
        i++;
      }
    }
    groups.push({ kind: 'tool-group', internalToolName, parts });
  }
  return groups;
}
