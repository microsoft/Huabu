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
 * Higher-level activity grouping lives in {@link groupByActivity} so this primitive
 * stays focused on tool-call coalescing.
 */

import { stripMarkdown } from '@huabu/shared/canvas-engine';

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

function taskCompleteText(part: GenericToolPart): string | undefined {
  let text: string | undefined;
  for (const entry of part.content ?? []) {
    if (entry.type === 'content' && entry.content.type === 'text') {
      text = entry.content.text.trimEnd();
    }
  }
  return text || undefined;
}

/**
 * Present a textual `task_complete` result as the assistant's final answer.
 * ACP tool updates are cumulative, so the last text frame is authoritative.
 * Pending, failed, or textless results remain tool cards.
 */
export function projectTaskCompleteResults(
  segments: AssistantSegment[],
): AssistantSegment[] {
  return segments.map((segment) => {
    if (
      segment.kind !== 'tool' ||
      segment.variant !== 'generic' ||
      segment.title !== 'task_complete' ||
      segment.status !== 'completed'
    ) {
      return segment;
    }
    const text = taskCompleteText(segment);
    return text ? { kind: 'text', text } : segment;
  });
}

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

export type ActivityOrContent =
  | { kind: 'activity'; startIndex: number; groups: SegmentGroup[] }
  | {
      kind: 'content';
      startIndex: number;
      group:
        | Extract<SegmentGroup, { kind: 'tool-group' }>
        | {
            kind: 'segment';
            segment: Exclude<AssistantSegment, { kind: 'tool' | 'thinking' }>;
          };
    };

export type ActivityDetail =
  | { kind: 'thinking'; startIndex: number; plainText: string }
  | {
      kind: 'tools';
      startIndex: number;
      groups: Extract<SegmentGroup, { kind: 'tool-group' }>[];
      summary: ActivitySummary;
    };

export interface ActivitySummary {
  visibleGroupCount: number;
  stepCount: number;
  changedFileCount: number;
}

export type ActivityStatus =
  | 'running'
  | 'completed'
  | 'waiting'
  | 'interrupted'
  | 'error';
export type ActivityEndStatus = Extract<
  ActivityStatus,
  'interrupted' | 'error'
>;

export function getActivityStatus(
  next: ActivityOrContent | undefined,
  context: {
    isStreaming: boolean;
    endStatus?: ActivityEndStatus;
    isAwaitingPermission: boolean;
  },
): ActivityStatus {
  if (next) {
    if (next.kind === 'content' && next.group.kind === 'segment') {
      const segment = next.group.segment;
      if (segment.kind === 'status') return segment.status;
      if (segment.kind === 'permission' && !segment.resolution) {
        return context.endStatus ?? 'waiting';
      }
    }
    return 'completed';
  }
  if (context.endStatus) return context.endStatus;
  if (context.isAwaitingPermission) return 'waiting';
  return context.isStreaming ? 'running' : 'completed';
}

/** Derive display text, tool runs, and both summary levels in one pass. */
export function describeActivity(groups: SegmentGroup[]): {
  details: ActivityDetail[];
  summary: ActivitySummary;
} {
  const details: ActivityDetail[] = [];
  let visibleGroupCount = 0;
  let stepCount = 0;
  const changedPaths = new Set<string>();
  const runChangedPaths = new Set<string>();
  const recordChangedPath = (path: string) => {
    changedPaths.add(path);
    runChangedPaths.add(path);
  };

  for (const [startIndex, group] of groups.entries()) {
    if (group.kind === 'segment') {
      if (group.segment.kind !== 'thinking') continue;
      const plainText = stripMarkdown(group.segment.text);
      if (plainText) {
        details.push({ kind: 'thinking', startIndex, plainText });
        visibleGroupCount++;
        stepCount++;
      }
      continue;
    }
    if (group.parts.length === 0) continue;
    const previous = details.at(-1);
    const run: Extract<ActivityDetail, { kind: 'tools' }> =
      previous?.kind === 'tools'
        ? previous
        : {
            kind: 'tools',
            startIndex,
            groups: [],
            summary: {
              visibleGroupCount: 0,
              stepCount: 0,
              changedFileCount: 0,
            },
          };
    if (previous?.kind !== 'tools') {
      runChangedPaths.clear();
      details.push(run);
    }
    run.groups.push(group);
    run.summary.visibleGroupCount++;
    run.summary.stepCount += group.parts.length;
    visibleGroupCount++;
    stepCount += group.parts.length;
    for (const part of group.parts) {
      if (part.variant === 'generic') {
        if (part.status !== 'completed' || part.toolKind !== 'edit') continue;
        for (const content of part.content ?? []) {
          if (
            content.type === 'diff' &&
            content.path.trim() &&
            content.oldText !== content.newText
          ) {
            recordChangedPath(content.path);
          }
        }
      } else if (
        part.variant === 'agent_tool' &&
        part.toolName === 'fs_write' &&
        (part.status === 'completed' || part.status === undefined) &&
        part.data?.status === 'success'
      ) {
        const result = part.data.data;
        if (
          typeof result === 'object' &&
          result !== null &&
          'ok' in result &&
          result.ok === true &&
          'target' in result &&
          typeof result.target === 'string' &&
          result.target.trim()
        ) {
          recordChangedPath(result.target);
        }
      }
    }
    run.summary.changedFileCount = runChangedPaths.size;
  }
  return {
    details,
    summary: {
      visibleGroupCount,
      stepCount,
      changedFileCount: changedPaths.size,
    },
  };
}

/**
 * Group contiguous thinking and ordinary tools without requiring a thinking
 * preamble. Keep rich result cards, task_complete fallbacks, and non-thinking
 * content outside. Original segment indices preserve comment addressing and
 * stable group identity as the tail receives streaming updates.
 */
export function groupByActivity(
  segments: AssistantSegment[],
): ActivityOrContent[] {
  const out: ActivityOrContent[] = [];
  let startIndex = 0;
  for (const group of groupAdjacentToolParts(segments)) {
    const contentGroup =
      group.kind === 'segment'
        ? group.segment.kind === 'thinking'
          ? undefined
          : { kind: 'segment' as const, segment: group.segment }
        : group.variant === 'agent_tool' ||
            (group.variant === 'generic' &&
              group.parts[0]?.title !== 'task_complete')
          ? undefined
          : group;
    const previous = out.at(-1);
    if (contentGroup) {
      out.push({ kind: 'content', startIndex, group: contentGroup });
    } else if (previous?.kind === 'activity') {
      previous.groups.push(group);
    } else {
      out.push({ kind: 'activity', startIndex, groups: [group] });
    }
    startIndex += group.kind === 'tool-group' ? group.parts.length : 1;
  }
  return out;
}
