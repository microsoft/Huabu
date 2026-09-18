// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  AGENT_COMMAND_SCHEMAS,
  SPACE_EXECUTE_MAX_COMMANDS,
  agentCanvasCommandSchema,
  builtInAgentCanvasCommandSchema,
  inspectNodesQuerySchema,
  rfsExecuteRequestSchema,
  spaceQueryResponseSchema,
} from './space-operations.js';
import {
  AGENT_CANVAS_COMMAND_TYPES,
  CANVAS_NODE_TYPES,
} from '../canvas/index.js';

describe('agentCanvasCommandSchema', () => {
  it('rejects the retired Pin command at both agent boundaries', () => {
    const command = {
      type: 'SET_PORTAL_NODE_PINS',
      updates: [
        {
          sourceCanvasId: 'canvas-source',
          sourceNodeIds: ['node-source'],
          pinned: true,
        },
      ],
    };
    expect(agentCanvasCommandSchema.safeParse(command).success).toBe(false);
    expect(builtInAgentCanvasCommandSchema.safeParse(command).success).toBe(
      false,
    );
    expect(AGENT_CANVAS_COMMAND_TYPES).not.toContain(command.type);
  });

  it.each(['canvasRef', 'frameRef', 'nodeRef'])(
    'retires the %s node kind',
    (nodeType) => {
      expect(CANVAS_NODE_TYPES).not.toContain(nodeType);
      const command = {
        type: 'CREATE_NODES',
        nodes: [{ nodeType, position: { x: 0, y: 0 } }],
      };
      expect(agentCanvasCommandSchema.safeParse(command).success).toBe(false);
      expect(builtInAgentCanvasCommandSchema.safeParse(command).success).toBe(
        false,
      );
    },
  );

  it('keeps spacePreview and Frame as supported canvas node kinds', () => {
    expect(CANVAS_NODE_TYPES).toContain('spacePreview');
    expect(CANVAS_NODE_TYPES).toContain('frame');
  });

  it('keeps the schema registry aligned with the agent command catalogue', () => {
    expect(Object.keys(AGENT_COMMAND_SCHEMAS).sort()).toEqual(
      [...AGENT_CANVAS_COMMAND_TYPES].sort(),
    );
  });

  it('accepts revision-guarded content updates', () => {
    expect(
      agentCanvasCommandSchema.safeParse({
        type: 'MERGE_NODE_DATA',
        patches: [
          {
            nodeId: 'node-1',
            expectRev: 'rev-1',
            patch: { content: 'Updated' },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('requires explicit positions and rejects caller-assigned create ids', () => {
    const missingPosition = agentCanvasCommandSchema.safeParse({
      type: 'CREATE_NODES',
      nodes: [{ nodeType: 'note', data: { label: 'Draft' } }],
    });
    const callerAssignedId = agentCanvasCommandSchema.safeParse({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'node-invented',
          nodeType: 'note',
          position: { x: 0, y: 0 },
        },
      ],
    });

    expect(missingPosition.success).toBe(false);
    expect(callerAssignedId.success).toBe(false);
  });

  it('rejects UI-only commands', () => {
    expect(
      agentCanvasCommandSchema.safeParse({
        type: 'SET_NODE_SELECTION',
        nodeIds: ['node-1'],
      }).success,
    ).toBe(false);
  });

  it('rejects caller-owned authorship metadata', () => {
    expect(
      agentCanvasCommandSchema.safeParse({
        type: 'CONNECT_NODES',
        edges: [
          {
            source: 'node-1',
            target: 'node-2',
            style: { label: 'supports', labelSource: 'user' },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('Space operation limits', () => {
  it('accepts a thread association only on inspect-node results', () => {
    const node = {
      id: 'node-agent',
      type: 'question',
      filename: 'nodes/Agent.md',
      position: { x: 0, y: 0 },
      absolutePosition: { x: 0, y: 0 },
      size: { width: 200, height: 80 },
      threadId: 'thread-agent',
    };

    expect(
      spaceQueryResponseSchema.safeParse({
        type: 'INSPECT_NODES',
        result: {
          count: 1,
          total: 1,
          truncated: false,
          nodes: [node],
        },
      }).success,
    ).toBe(true);
    expect(
      spaceQueryResponseSchema.safeParse({
        type: 'GET_SPACE_OUTLINE',
        result: {
          version: 1,
          bbox: null,
          nodes: [node],
          edges: [],
          spatial: { clusters: [] },
        },
      }).success,
    ).toBe(false);
  });

  it('bounds inspect results', () => {
    expect(
      inspectNodesQuerySchema.safeParse({
        type: 'INSPECT_NODES',
        ids: ['node-1'],
        limit: 201,
      }).success,
    ).toBe(false);
  });

  it('bounds execute batches', () => {
    const command = {
      type: 'DELETE_NODES' as const,
      nodeIds: ['node-1'],
    };
    expect(
      rfsExecuteRequestSchema.safeParse({
        commands: Array.from(
          { length: SPACE_EXECUTE_MAX_COMMANDS + 1 },
          () => command,
        ),
      }).success,
    ).toBe(false);
  });
});
