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
 * Plus `groupByThinkingPhase` boundary rules — see that suite below.
 */

import { describe, expect, it } from 'vitest';

import { groupAdjacentToolParts, groupByThinkingPhase } from './groupParts';

import type { AssistantSegment } from '../../../store/chatTypes';

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
): AssistantSegment {
  return {
    kind: 'tool',
    toolCallId,
    title,
    variant: 'generic',
  };
}

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

describe('groupByThinkingPhase', () => {
  it('absorbs tool runs that follow a thinking into one phase', () => {
    const phases = groupByThinkingPhase([
      thinking('Planning guide IA'),
      agentTool('tc-1', 'read'),
      agentTool('tc-2', 'read'),
      genericTool('tc-3'),
    ]);
    expect(phases).toHaveLength(1);
    const p = phases[0]!;
    expect(p.kind).toBe('phase');
    if (p.kind === 'phase') {
      expect(p.thinking.text).toBe('Planning guide IA');
      // adjacent agent_tool merged + the generic tool stays its own
      // group → 2 tool groups under the phase.
      expect(p.toolGroups).toHaveLength(2);
      // Trailing phase with nothing after it is NOT closed yet.
      expect(p.closed).toBe(false);
    }
  });

  it('closes a phase when the next thinking arrives and opens a new one', () => {
    const phases = groupByThinkingPhase([
      thinking('Planning guide IA'),
      agentTool('tc-1', 'read'),
      thinking('Shaping guide plan'),
      agentTool('tc-2', 'grep'),
    ]);
    expect(phases).toHaveLength(2);
    const [first, second] = phases as [
      Extract<(typeof phases)[number], { kind: 'phase' }>,
      Extract<(typeof phases)[number], { kind: 'phase' }>,
    ];
    expect(first.kind).toBe('phase');
    expect(second.kind).toBe('phase');
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(first.thinking.text).toBe('Planning guide IA');
    expect(second.thinking.text).toBe('Shaping guide plan');
  });

  it('closes the phase before a text segment (loose) and reopens on next thinking', () => {
    const phases = groupByThinkingPhase([
      thinking('Investigating'),
      agentTool('tc-1', 'read'),
      text('Final answer.'),
      thinking('Refining'),
      agentTool('tc-2', 'grep'),
    ]);
    expect(phases).toHaveLength(3);
    expect(phases[0]?.kind).toBe('phase');
    if (phases[0]?.kind === 'phase') expect(phases[0].closed).toBe(true);
    expect(phases[1]?.kind).toBe('loose');
    if (phases[1]?.kind === 'loose')
      expect(phases[1].group.kind).toBe('segment');
    expect(phases[2]?.kind).toBe('phase');
    if (phases[2]?.kind === 'phase') expect(phases[2].closed).toBe(false);
  });

  it('emits tool runs that appear before any thinking as loose groups', () => {
    const phases = groupByThinkingPhase([
      agentTool('tc-1', 'read'),
      spaceCommandsTool('tc-2'),
      thinking('Now planning'),
      agentTool('tc-3', 'grep'),
    ]);
    // 1 loose agent_tool group + 1 loose space_commands + 1 phase
    expect(phases).toHaveLength(3);
    expect(phases[0]?.kind).toBe('loose');
    expect(phases[1]?.kind).toBe('loose');
    expect(phases[2]?.kind).toBe('phase');
    if (phases[2]?.kind === 'phase') {
      expect(phases[2].toolGroups).toHaveLength(1);
      expect(phases[2].closed).toBe(false);
    }
  });

  it('represents a bare thinking with no tools as an empty phase', () => {
    const phases = groupByThinkingPhase([thinking('Just thinking')]);
    expect(phases).toHaveLength(1);
    const p = phases[0]!;
    if (p.kind === 'phase') {
      expect(p.toolGroups).toHaveLength(0);
      expect(p.closed).toBe(false);
    }
  });
});
