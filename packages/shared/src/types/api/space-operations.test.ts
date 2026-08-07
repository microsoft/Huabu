// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  AGENT_COMMAND_SCHEMAS,
  SPACE_EXECUTE_MAX_COMMANDS,
  agentCanvasCommandSchema,
  inspectNodesQuerySchema,
  rfsExecuteRequestSchema,
} from './space-operations.js';
import { AGENT_CANVAS_COMMAND_TYPES } from '../canvas/index.js';

describe('agentCanvasCommandSchema', () => {
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
