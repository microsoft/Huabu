// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for `groupAdjacentToolParts` — the helper that turns an
 * assistant message's flat `parts` array into the dispatch-ready
 * group shape AIMessage iterates over.
 *
 * Invariants under test:
 *  - Non-tool parts pass through as singleton `segment` groups.
 *  - Adjacent `agent_tool` parts with the SAME `toolName` merge into
 *    one `tool-group`.
 *  - `generic` / `space_commands` / `web_search` parts never merge
 *    with each other or with `agent_tool` parts.
 *  - A different `agent_tool.toolName` starts a fresh group.
 *
 * Plus `groupByActivity` boundary and identity rules.
 */

import { describe, expect, it } from 'vitest';

import {
  groupAdjacentToolParts,
  describeActivity,
  groupByActivity,
  getActivityStatus,
  projectTaskCompleteResults,
} from './groupParts';
import {
  assistantMessageText,
  type AssistantSegment,
} from '../../../store/chatTypes';

import type { AgentToolPart, GenericToolPart } from '@huabu/shared';

function text(t: string): AssistantSegment {
  return { kind: 'text', text: t };
}

function thinking(t: string): AssistantSegment {
  return { kind: 'thinking', text: t };
}

function agentTool(
  toolCallId: string,
  toolName: 'read' | 'grep' | 'inspect_nodes',
): AssistantSegment {
  return {
    kind: 'tool',
    toolCallId,
    title: toolName,
    variant: 'agent_tool',
    toolName,
  };
}

function spaceCommandsTool(toolCallId: string): AssistantSegment {
  return {
    kind: 'tool',
    toolCallId,
    title: 'space_commands',
    variant: 'space_commands',
  };
}

function genericTool(
  toolCallId: string,
  title = 'External op',
  output?: string,
): GenericToolPart {
  return {
    kind: 'tool',
    toolCallId,
    title,
    variant: 'generic',
    ...(output
      ? {
          content: [
            {
              type: 'content' as const,
              content: { type: 'text' as const, text: output },
            },
          ],
        }
      : {}),
  };
}

describe('describeActivity', () => {
  it('normalizes thinking once without stripping literal code a second time', () => {
    const segment = thinking(
      '`---`\n\nRead `use_agent_stream.ts` as `Array<T>`',
    );
    const activity = describeActivity(groupAdjacentToolParts([segment]));
    expect(activity).toEqual({
      details: [
        {
          kind: 'thinking',
          startIndex: 0,
          plainText: '---\n\nRead use_agent_stream.ts as Array<T>',
        },
      ],
      summary: { visibleGroupCount: 1, stepCount: 1, changedFileCount: 0 },
    });
    expect(segment).toEqual(
      thinking('`---`\n\nRead `use_agent_stream.ts` as `Array<T>`'),
    );
  });

  it('shares one evidence scan while deduplicating changed paths separately for each summary level', () => {
    const edit = (id: string, path: string): GenericToolPart => ({
      ...genericTool(id),
      status: 'completed',
      toolKind: 'edit',
      content: [{ type: 'diff', path, oldText: 'before', newText: 'after' }],
    });
    const activity = describeActivity(
      groupAdjacentToolParts([
        thinking('First'),
        edit('a', 'same.ts'),
        edit('b', 'same.ts'),
        thinking('Next'),
        edit('c', 'same.ts'),
        edit('d', 'another.ts'),
      ]),
    );
    expect(activity.summary).toEqual({
      visibleGroupCount: 6,
      stepCount: 6,
      changedFileCount: 2,
    });
    expect(
      activity.details
        .filter((detail) => detail.kind === 'tools')
        .map((detail) => detail.summary),
    ).toEqual([
      { visibleGroupCount: 2, stepCount: 2, changedFileCount: 1 },
      { visibleGroupCount: 2, stepCount: 2, changedFileCount: 2 },
    ]);
  });

  it('preserves full thinking, chronological runs and stable starting indices', () => {
    const groups = groupAdjacentToolParts([
      thinking('First\n\nAll details'),
      genericTool('a'),
      genericTool('b'),
      thinking('Next'),
      agentTool('c', 'read'),
      agentTool('d', 'read'),
    ]);
    expect(describeActivity(groups).details).toEqual([
      { kind: 'thinking', startIndex: 0, plainText: 'First\n\nAll details' },
      {
        kind: 'tools',
        startIndex: 1,
        groups: groups.slice(1, 3),
        summary: { visibleGroupCount: 2, stepCount: 2, changedFileCount: 0 },
      },
      { kind: 'thinking', startIndex: 3, plainText: 'Next' },
      {
        kind: 'tools',
        startIndex: 4,
        groups: groups.slice(4),
        summary: { visibleGroupCount: 1, stepCount: 2, changedFileCount: 0 },
      },
    ]);
  });

  it('does not create a thinking boundary for Markdown-only placeholders', () => {
    const groups = groupAdjacentToolParts([
      genericTool('a'),
      thinking('---'),
      genericTool('b'),
    ]);
    expect(describeActivity(groups).details).toEqual([
      {
        kind: 'tools',
        startIndex: 0,
        groups: [groups[0], groups[2]],
        summary: { visibleGroupCount: 2, stepCount: 2, changedFileCount: 0 },
      },
    ]);
  });
});

describe('projectTaskCompleteResults', () => {
  it('projects the latest task_complete text as copyable assistant text', () => {
    const projected = projectTaskCompleteResults([
      thinking('Finishing'),
      {
        ...genericTool('tc-1', 'task_complete'),
        status: 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Partial result' },
          },
          {
            type: 'content',
            content: { type: 'text', text: 'Final **result**\n\nNext step.\n' },
          },
        ],
      },
    ]);

    expect(projected).toEqual([
      thinking('Finishing'),
      text('Final **result**\n\nNext step.'),
    ]);
    expect(assistantMessageText(projected)).toBe(
      'Final **result**\n\nNext step.',
    );
  });

  it('keeps a task_complete without text as a tool fallback', () => {
    const tool = {
      ...genericTool('tc-1', 'task_complete'),
      status: 'completed' as const,
    };

    expect(projectTaskCompleteResults([tool])).toEqual([tool]);
  });

  it.each(['pending', 'failed'] as const)(
    'keeps a %s task_complete as a tool fallback',
    (status) => {
      const tool = {
        ...genericTool('tc-1', 'task_complete', 'Not a final result'),
        status,
      };

      expect(projectTaskCompleteResults([tool])).toEqual([tool]);
    },
  );
});

describe('groupAdjacentToolParts', () => {
  it('passes non-tool parts through as singleton segment groups', () => {
    const groups = groupAdjacentToolParts([text('a'), text('b')]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.kind).toBe('segment');
    expect(groups[1]?.kind).toBe('segment');
  });

  it('merges a run of same-name agent_tool parts', () => {
    const groups = groupAdjacentToolParts([
      agentTool('tc-1', 'read'),
      agentTool('tc-2', 'read'),
      agentTool('tc-3', 'read'),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.kind).toBe('tool-group');
    if (g.kind === 'tool-group' && g.variant === 'agent_tool') {
      expect(g.toolName).toBe('read');
      expect(g.parts).toHaveLength(3);
    }
  });

  it('starts a fresh group on a different agent_tool.toolName', () => {
    const groups = groupAdjacentToolParts([
      agentTool('tc-1', 'read'),
      agentTool('tc-2', 'grep'),
      agentTool('tc-3', 'grep'),
    ]);
    expect(groups).toHaveLength(2);
    if (
      groups[0]?.kind === 'tool-group' &&
      groups[0].variant === 'agent_tool'
    ) {
      expect(groups[0].toolName).toBe('read');
      expect(groups[0].parts).toHaveLength(1);
    }
    if (
      groups[1]?.kind === 'tool-group' &&
      groups[1].variant === 'agent_tool'
    ) {
      expect(groups[1].toolName).toBe('grep');
      expect(groups[1].parts).toHaveLength(2);
    }
  });

  it('never merges generic tool parts', () => {
    const groups = groupAdjacentToolParts([
      genericTool('tc-1'),
      genericTool('tc-2'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.kind).toBe('tool-group');
    expect(groups[1]?.kind).toBe('tool-group');
    if (groups[0]?.kind === 'tool-group') {
      expect(groups[0].variant).toBe('generic');
      expect(groups[0].parts).toHaveLength(1);
    }
  });

  it('never merges space_commands tool parts', () => {
    const groups = groupAdjacentToolParts([
      spaceCommandsTool('tc-1'),
      spaceCommandsTool('tc-2'),
    ]);
    expect(groups).toHaveLength(2);
    if (groups[0]?.kind === 'tool-group') {
      expect(groups[0].variant).toBe('space_commands');
      expect(groups[0].parts).toHaveLength(1);
    }
  });

  it('splits agent_tool and generic runs', () => {
    const groups = groupAdjacentToolParts([
      agentTool('tc-1', 'read'),
      agentTool('tc-2', 'read'),
      genericTool('tc-3'),
      agentTool('tc-4', 'read'),
    ]);
    expect(groups).toHaveLength(3);
  });

  it('intersperses text between tool groups', () => {
    const groups = groupAdjacentToolParts([
      agentTool('tc-1', 'inspect_nodes'),
      agentTool('tc-2', 'inspect_nodes'),
      text('summary'),
      agentTool('tc-3', 'inspect_nodes'),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]?.kind).toBe('tool-group');
    expect(groups[1]?.kind).toBe('segment');
    expect(groups[2]?.kind).toBe('tool-group');
  });
});

describe('groupByActivity', () => {
  it('groups tools without a thinking preamble and retains every call', () => {
    const segments = [
      genericTool('tc-1', 'Read the same file'),
      genericTool('tc-2', 'Read the same file'),
      agentTool('tc-3', 'read'),
      agentTool('tc-4', 'read'),
    ];
    expect(groupByActivity(segments)).toEqual([
      {
        kind: 'activity',
        startIndex: 0,
        groups: groupAdjacentToolParts(segments),
      },
    ]);
  });

  describe('activity summaries', () => {
    function summarize(segments: AssistantSegment[]) {
      return describeActivity(groupAdjacentToolParts(segments)).summary;
    }

    function edit(id: string, path = 'src/example.ts'): GenericToolPart {
      return {
        ...genericTool(id),
        toolKind: 'edit',
        status: 'completed',
        content: [{ type: 'diff', path, oldText: 'before', newText: 'after' }],
      };
    }

    it('counts merged calls as separate steps but only one visible row', () => {
      expect(
        summarize([
          agentTool('a', 'read'),
          agentTool('b', 'read'),
          agentTool('c', 'read'),
        ]),
      ).toEqual({ visibleGroupCount: 1, stepCount: 3, changedFileCount: 0 });
    });

    describe('getActivityStatus', () => {
      const context = { isStreaming: true, isAwaitingPermission: false };

      it('completes at a normal boundary without waiting for the entire turn', () => {
        const next = groupByActivity([text('Continuing')])[0];
        expect(getActivityStatus(next, context)).toBe('completed');
        expect(
          getActivityStatus(next, { ...context, endStatus: 'error' }),
        ).toBe('completed');
      });

      it('uses streaming lifecycle for a trailing activity', () => {
        expect(getActivityStatus(undefined, context)).toBe('running');
        expect(
          getActivityStatus(undefined, { ...context, isStreaming: false }),
        ).toBe('completed');
      });

      it.each(['error', 'interrupted'] as const)(
        'preserves a terminal %s without requiring tool metadata',
        (status) => {
          const next = groupByActivity([{ kind: 'status', status }])[0];
          expect(getActivityStatus(next, context)).toBe(status);
          expect(
            getActivityStatus(undefined, { ...context, endStatus: status }),
          ).toBe(status);
        },
      );

      it('waits for unresolved permission rather than claiming completion', () => {
        const permission: AssistantSegment = {
          kind: 'permission',
          requestId: 'p',
          toolCall: {},
          options: [],
        };
        const next = groupByActivity([permission])[0];
        expect(getActivityStatus(next, context)).toBe('waiting');
        expect(
          getActivityStatus(next, { ...context, endStatus: 'interrupted' }),
        ).toBe('interrupted');
        expect(
          getActivityStatus(undefined, {
            ...context,
            isAwaitingPermission: true,
          }),
        ).toBe('waiting');
      });
    });

    it('counts nonempty thinking rows, not empty streaming placeholders', () => {
      expect(summarize([thinking(' \n'), genericTool('a')])).toEqual({
        visibleGroupCount: 1,
        stepCount: 1,
        changedFileCount: 0,
      });

      expect(
        summarize([thinking('Plan'), genericTool('a'), thinking('Check')]),
      ).toEqual({ visibleGroupCount: 3, stepCount: 3, changedFileCount: 0 });
      expect(summarize([thinking('')])).toEqual({
        visibleGroupCount: 0,
        stepCount: 0,
        changedFileCount: 0,
      });
    });

    it('does not wrap a lone tool because a thinking placeholder contains only Markdown', () => {
      expect(summarize([thinking('---'), genericTool('a')])).toEqual({
        visibleGroupCount: 1,
        stepCount: 1,
        changedFileCount: 0,
      });
    });

    it('counts unique paths from completed edit diffs, not repeated calls or diff frames', () => {
      const a = edit('a');
      expect(
        summarize([
          a,
          {
            ...edit('b'),
            content: [...(a.content ?? []), ...(a.content ?? [])],
          },
          edit('c', 'src/second.ts'),
        ]),
      ).toEqual({ visibleGroupCount: 3, stepCount: 3, changedFileCount: 2 });
    });

    it.each(['pending', 'in_progress', 'failed', undefined] as const)(
      'does not count an unconfirmed edit with status %s',
      (status) =>
        expect(summarize([{ ...edit('a'), status }]).changedFileCount).toBe(0),
    );

    it('does not infer file changes from reads, locations, titles, or unchanged diffs', () => {
      expect(
        summarize([
          { ...edit('a'), toolKind: 'read' },
          { ...edit('b'), content: [], locations: [{ path: 'src/guess.ts' }] },
          { ...genericTool('c', 'Edited 10 files'), status: 'completed' },
          {
            ...edit('d'),
            content: [
              {
                type: 'diff',
                path: 'src/same.ts',
                oldText: 'same',
                newText: 'same',
              },
            ],
          },
        ]).changedFileCount,
      ).toBe(0);
    });

    it('requires a confirmed fs_write result rather than its provisional input or rejection', () => {
      const write: AgentToolPart = {
        kind: 'tool',
        variant: 'agent_tool',
        toolName: 'fs_write',
        toolCallId: 'write',
        title: 'Write memory',
        status: 'completed',
        data: {
          tool: 'fs_write',
          status: 'success',
          data: { ok: true, target: '/memory/user.md', reason: 'overwritten' },
        },
      };
      expect(
        summarize([write, { ...write, toolCallId: 'write-again' }]),
      ).toEqual({ visibleGroupCount: 1, stepCount: 2, changedFileCount: 1 });
      expect(
        summarize([
          { ...write, status: 'in_progress' },
          { ...write, status: 'failed' },
          {
            ...write,
            data: {
              tool: 'fs_write',
              status: 'success',
              data: { path: '/memory/user.md' },
            },
          },
          {
            ...write,
            data: {
              tool: 'fs_write',
              status: 'success',
              data: { ok: false, target: '/memory/user.md' },
            },
          },
        ]).changedFileCount,
      ).toBe(0);
    });
  });

  it('keeps multiple thinking segments and interleaved tools in one ordered group', () => {
    const segments = [
      genericTool('tc-1'),
      thinking('Investigating'),
      agentTool('tc-2', 'read'),
      thinking('Checking results'),
      genericTool('tc-3'),
    ];
    expect(groupByActivity(segments)).toEqual([
      {
        kind: 'activity',
        startIndex: 0,
        groups: groupAdjacentToolParts(segments),
      },
    ]);
  });

  const boundaries: AssistantSegment[] = [
    text('Summary'),
    { kind: 'plan', entries: [] },
    { kind: 'status', status: 'error', detail: 'Could not finish' },
    { kind: 'status', status: 'interrupted' },
    {
      kind: 'permission',
      requestId: 'permission-1',
      toolCall: { title: 'Write file' },
      options: [],
    },
    spaceCommandsTool('changes'),
    {
      kind: 'tool',
      variant: 'image_generation',
      toolCallId: 'image',
      title: 'Generated image',
    },
    {
      kind: 'tool',
      variant: 'snapshot_nodes',
      toolCallId: 'snapshot',
      title: 'Snapshot',
    },
    {
      kind: 'tool',
      variant: 'web_search',
      toolCallId: 'search',
      title: 'Search sources',
    },
    genericTool('complete', 'task_complete'),
  ];

  it.each(boundaries)('keeps boundary %# outside the activity', (boundary) => {
    const before = [thinking('Investigating'), agentTool('tc-1', 'read')];
    const after = [genericTool('tc-2'), thinking('Continuing')];
    expect(groupByActivity([...before, boundary, ...after])).toEqual([
      {
        kind: 'activity',
        startIndex: 0,
        groups: groupAdjacentToolParts(before),
      },
      {
        kind: 'content',
        startIndex: 2,
        group: groupAdjacentToolParts([boundary])[0],
      },
      {
        kind: 'activity',
        startIndex: 3,
        groups: groupAdjacentToolParts(after),
      },
    ]);
  });

  it('preserves original text indices and references after merged tool calls', () => {
    const answer = text('Final answer');
    const segments = [
      thinking('Working'),
      agentTool('tc-1', 'read'),
      agentTool('tc-2', 'read'),
      answer,
    ];
    const content = groupByActivity(segments)[1];
    expect(content).toEqual({
      kind: 'content',
      startIndex: 3,
      group: { kind: 'segment', segment: answer },
    });
    if (content?.kind === 'content' && content.group.kind === 'segment') {
      expect(content.group.segment).toBe(answer);
    }
    expect(assistantMessageText(segments)).toBe('Final answer');
  });

  it('projects task_complete into separate copyable prose at the same index', () => {
    const display = projectTaskCompleteResults([
      thinking('Finishing'),
      genericTool('read'),
      {
        ...genericTool('complete', 'task_complete', 'Final answer'),
        status: 'completed',
      },
    ]);
    expect(groupByActivity(display)[1]).toEqual({
      kind: 'content',
      startIndex: 2,
      group: { kind: 'segment', segment: text('Final answer') },
    });
    expect(assistantMessageText(display)).toBe('Final answer');
  });

  it('keeps a failed ordinary tool in the activity without marking a task failure', () => {
    const tool = { ...genericTool('failed'), status: 'failed' as const };
    expect(groupByActivity([tool])[0]?.kind).toBe('activity');
  });

  it('handles empty and thinking-only messages', () => {
    expect(groupByActivity([])).toEqual([]);
    const segments = [thinking('Just thinking')];
    expect(groupByActivity(segments)).toEqual([
      {
        kind: 'activity',
        startIndex: 0,
        groups: groupAdjacentToolParts(segments),
      },
    ]);
  });
});
