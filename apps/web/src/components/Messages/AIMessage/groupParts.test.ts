/**
 * Unit tests for `groupAdjacentToolParts` — the helper that turns an
 * assistant message's flat `parts` array into the dispatch-ready
 * group shape AIMessage iterates over.
 *
 * Invariants under test:
 *  - Non-tool parts pass through as singleton `segment` groups.
 *  - Adjacent `agent_tool` parts with the SAME `toolName` merge into
 *    one `tool-group`.
 *  - `generic` / `canvas_commands` / `web_search` parts never merge
 *    with each other or with `agent_tool` parts.
 *  - A different `agent_tool.toolName` starts a fresh group.
 */

import { describe, expect, it } from 'vitest';

import { groupAdjacentToolParts } from './groupParts';

import type { AssistantSegment } from '../../../store/chatTypes';

function text(t: string): AssistantSegment {
  return { kind: 'text', text: t };
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

function canvasCommandsTool(toolCallId: string): AssistantSegment {
  return {
    kind: 'tool',
    toolCallId,
    title: 'canvas_commands',
    variant: 'canvas_commands',
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

  it('never merges canvas_commands tool parts', () => {
    const groups = groupAdjacentToolParts([
      canvasCommandsTool('tc-1'),
      canvasCommandsTool('tc-2'),
    ]);
    expect(groups).toHaveLength(2);
    if (groups[0]?.kind === 'tool-group') {
      expect(groups[0].variant).toBe('canvas_commands');
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
