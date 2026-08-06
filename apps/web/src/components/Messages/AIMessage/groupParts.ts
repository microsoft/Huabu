// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
 *  - `space_commands`, `web_search`, and `generic` parts are each
 *    their OWN group — they carry per-call UI (change list, source
 *    list, status card) and merging would lose information.
 *
 * Non-tool segments (text/thinking/plan/status) become singleton
 * groups so the dispatch in `AIMessage` only iterates once.
 *
 * Higher-level phase grouping (a `thinking` followed by its tool
 * runs) lives in {@link groupByThinkingPhase} so this primitive
 * stays focused on tool-call coalescing.
 */

import type { AssistantSegment } from '../../../store/chatTypes';
import type {
  AgentToolPart,
  AssistantToolPart,
  SpaceCommandsToolPart,
  GenericToolPart,
  ImageGenerationToolPart,
  SnapshotNodesToolPart,
  WebSearchToolPart,
} from '@huabu/shared';

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
      variant: 'space_commands';
      parts: SpaceCommandsToolPart[];
    }
  | {
      kind: 'tool-group';
      variant: 'web_search';
      parts: WebSearchToolPart[];
    }
  | {
      kind: 'tool-group';
      variant: 'image_generation';
      parts: ImageGenerationToolPart[];
    }
  | {
      kind: 'tool-group';
      variant: 'snapshot_nodes';
      parts: SnapshotNodesToolPart[];
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
    case 'space_commands':
    case 'web_search':
    case 'image_generation':
    case 'snapshot_nodes':
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
      case 'space_commands':
        groups.push({
          kind: 'tool-group',
          variant: 'space_commands',
          parts: parts as SpaceCommandsToolPart[],
        });
        break;
      case 'web_search':
        groups.push({
          kind: 'tool-group',
          variant: 'web_search',
          parts: parts as WebSearchToolPart[],
        });
        break;
      case 'image_generation':
        groups.push({
          kind: 'tool-group',
          variant: 'image_generation',
          parts: parts as ImageGenerationToolPart[],
        });
        break;
      case 'snapshot_nodes':
        groups.push({
          kind: 'tool-group',
          variant: 'snapshot_nodes',
          parts: parts as SnapshotNodesToolPart[],
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

/**
 * A "thinking phase" — a thinking segment together with all the
 * tool runs that immediately follow it. Models the typical agent
 * loop "say what I'm about to do → do it (tool calls) → ...".
 *
 * Phase boundary rules:
 *  - A `thinking` segment OPENS a phase.
 *  - A phase swallows trailing `tool-group` entries until either:
 *      • another `thinking` arrives → that thinking opens a new
 *        phase, the previous phase is "closed" (auto-collapses);
 *      • any non-tool, non-thinking segment arrives (text, plan,
 *        permission, status) → the phase closes BEFORE that
 *        segment, which then renders as its own loose group.
 *  - Tool groups / loose segments that appear BEFORE any thinking
 *    in the message render as their own loose entries with no
 *    surrounding phase — preserves backward-compat for agents that
 *    never emit thinking chunks.
 *
 * A phase is "closed" iff another phase or any loose segment exists
 * after it in the same message. Callers use `closed` to drive the
 * auto-collapse signal: while the latest phase is still the tail of
 * the message, its body stays visible.
 */
export type ThinkingPhase = {
  kind: 'phase';
  thinking: Extract<AssistantSegment, { kind: 'thinking' }>;
  toolGroups: Extract<SegmentGroup, { kind: 'tool-group' }>[];
  /** True once another phase or loose segment follows it. */
  closed: boolean;
};

export type PhaseOrLoose =
  | ThinkingPhase
  | { kind: 'loose'; group: SegmentGroup };

/**
 * Pure helper. Wraps {@link groupAdjacentToolParts}'s output into a
 * phase list. See {@link ThinkingPhase} for the boundary rules.
 */
export function groupByThinkingPhase(
  segments: AssistantSegment[],
): PhaseOrLoose[] {
  const groups = groupAdjacentToolParts(segments);
  const out: PhaseOrLoose[] = [];
  let current: ThinkingPhase | null = null;

  for (const g of groups) {
    if (g.kind === 'segment' && g.segment.kind === 'thinking') {
      if (current) out.push(current);
      current = {
        kind: 'phase',
        thinking: g.segment,
        toolGroups: [],
        closed: false,
      };
      continue;
    }
    if (g.kind === 'tool-group' && current) {
      current.toolGroups.push(g);
      continue;
    }
    // Non-tool, non-thinking segment (text, plan, permission,
    // status) closes the open phase before rendering as a loose entry.
    if (current) {
      current.closed = true;
      out.push(current);
      current = null;
    }
    out.push({ kind: 'loose', group: g });
  }
  if (current) out.push(current);

  // A trailing phase is "closed" only if anything followed it; the
  // construction above already enforces that (a closed phase was
  // flushed before the following entry). Mark every non-tail phase
  // closed as a final sweep so callers can rely on the flag alone.
  for (let i = 0; i < out.length - 1; i++) {
    const entry = out[i]!;
    if (entry.kind === 'phase') entry.closed = true;
  }
  return out;
}
