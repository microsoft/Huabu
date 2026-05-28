/**
 * Unit tests for `groupAdjacentToolParts` — the helper that turns an
 * assistant message's flat `parts` array into the dispatch-ready
 * group shape AIMessage iterates over.
 *
 * Invariants under test:
 *  - Non-tool parts pass through as singleton `segment` groups.
 *  - Adjacent tool parts with the SAME `internalToolName` merge into
 *    one `tool-group`.
 *  - ACP-native parts (no `internalToolName`) never merge with each
 *    other or with internal parts.
 *  - A different internalToolName starts a fresh group.
 */

import { describe, expect, it } from 'vitest';

import { groupAdjacentToolParts } from './groupParts';

import type { AssistantSegment } from '../../store/chatTypes';

function text(t: string): AssistantSegment {
  return { kind: 'text', text: t };
}

function internalTool(
  toolCallId: string,
  name: 'read' | 'grep' | 'inspect_nodes' | 'canvas_commands',
): AssistantSegment {
  return {
    kind: 'tool',
    toolCallId,
    title: name,
    internalToolName: name,
  };
}

function acpTool(toolCallId: string, title = 'External op'): AssistantSegment {
  return {
    kind: 'tool',
    toolCallId,
    title,
  };
}

describe('groupAdjacentToolParts', () => {
  it('passes non-tool parts through as singleton segment groups', () => {
    const groups = groupAdjacentToolParts([text('a'), text('b')]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.kind).toBe('segment');
    expect(groups[1]?.kind).toBe('segment');
  });

  it('merges a run of same-name internal tool parts', () => {
    const groups = groupAdjacentToolParts([
      internalTool('tc-1', 'read'),
      internalTool('tc-2', 'read'),
      internalTool('tc-3', 'read'),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.kind).toBe('tool-group');
    if (g.kind === 'tool-group') {
      expect(g.internalToolName).toBe('read');
      expect(g.parts).toHaveLength(3);
    }
  });

  it('starts a fresh group on a different internalToolName', () => {
    const groups = groupAdjacentToolParts([
      internalTool('tc-1', 'read'),
      internalTool('tc-2', 'grep'),
      internalTool('tc-3', 'grep'),
    ]);
    expect(groups).toHaveLength(2);
    if (groups[0]?.kind === 'tool-group') {
      expect(groups[0].internalToolName).toBe('read');
      expect(groups[0].parts).toHaveLength(1);
    }
    if (groups[1]?.kind === 'tool-group') {
      expect(groups[1].internalToolName).toBe('grep');
      expect(groups[1].parts).toHaveLength(2);
    }
  });

  it('never merges ACP-native tool parts (no internalToolName)', () => {
    const groups = groupAdjacentToolParts([acpTool('tc-1'), acpTool('tc-2')]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.kind).toBe('tool-group');
    expect(groups[1]?.kind).toBe('tool-group');
    // Each ACP-native part stays in its own singleton group.
    if (groups[0]?.kind === 'tool-group') {
      expect(groups[0].internalToolName).toBeUndefined();
      expect(groups[0].parts).toHaveLength(1);
    }
  });

  it('splits internal and ACP-native runs', () => {
    const groups = groupAdjacentToolParts([
      internalTool('tc-1', 'read'),
      internalTool('tc-2', 'read'),
      acpTool('tc-3'),
      internalTool('tc-4', 'read'),
    ]);
    expect(groups).toHaveLength(3);
  });

  it('intersperses text between tool groups', () => {
    const groups = groupAdjacentToolParts([
      internalTool('tc-1', 'inspect_nodes'),
      internalTool('tc-2', 'inspect_nodes'),
      text('summary'),
      internalTool('tc-3', 'inspect_nodes'),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]?.kind).toBe('tool-group');
    expect(groups[1]?.kind).toBe('segment');
    expect(groups[2]?.kind).toBe('tool-group');
  });
});
