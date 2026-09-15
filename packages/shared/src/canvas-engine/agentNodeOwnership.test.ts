// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  changesAgentNodePreparation,
  preserveAgentNodeOwnedData,
  projectAgentNodeEditableData,
  replayAgentNodeEditableData,
} from './agentNodeOwnership.js';
import { executeCanvasCommands } from './executor.js';
import { putCanvasBodySchema } from '../types/api/canvas.js';

describe('Agent Node ownership', () => {
  const data = {
    content: 'Prompt',
    bindingState: 'bound',
    status: 'done',
    invocationToken: 'current',
    threadId: 'thread-agent',
    viewed: false,
    errorMessage: '',
  };

  it('separates complete reads from editable structure DTOs', () => {
    const node = {
      id: 'node-agent',
      type: 'question',
      position: { x: 0, y: 0 },
      data,
    };
    expect(
      putCanvasBodySchema.safeParse({ version: 1, state: { nodes: [node] } })
        .success,
    ).toBe(false);
    expect(
      putCanvasBodySchema.safeParse({
        version: 1,
        state: {
          nodes: [{ ...node, data: projectAgentNodeEditableData(data) }],
        },
      }).success,
    ).toBe(true);
    expect(
      preserveAgentNodeOwnedData({ content: 'Edited', status: 'idle' }, data),
    ).toEqual({ ...data, content: 'Edited' });
  });

  it('does not replay untouched historical preparation or runtime metadata', () => {
    expect(
      replayAgentNodeEditableData(
        { ...data, agentBinding: { kind: 'external', profileId: 'new' } },
        { ...data, label: 'After', agentBinding: { kind: 'internal' } },
        {
          ...data,
          status: 'idle',
          label: 'Before',
          agentBinding: { kind: 'internal' },
        },
      ),
    ).toEqual({
      ...data,
      label: 'Before',
      agentBinding: { kind: 'external', profileId: 'new' },
    });
  });

  it('does not reserve Agent field names on unrelated node types', () => {
    const node = {
      id: 'node-note',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { content: 'Note', status: 'custom', threadId: 'reference' },
    };
    expect(
      putCanvasBodySchema.safeParse({
        version: 1,
        state: { nodes: [node] },
      }).success,
    ).toBe(true);
    const result = executeCanvasCommands(
      {
        source: 'ui',
        commands: [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              {
                nodeId: 'node-note',
                patch: { status: 'updated', threadId: 'another' },
              },
            ],
          },
        ],
      },
      { canvasId: 'canvas-test', nodes: [node], edges: [] },
    );
    expect(result.commandResults[0]?.applied).toBe(true);
    expect(result.writeResult.nodes[0]?.data).toMatchObject({
      status: 'updated',
      threadId: 'another',
    });
  });

  it('protects identity and launch overrides without freezing display aliases or mode', () => {
    const current = {
      agentBinding: { kind: 'external', profileId: 'a', alias: 'Old' },
    };
    expect(changesAgentNodePreparation(current, { agentMode: 'operate' })).toBe(
      false,
    );
    expect(
      changesAgentNodePreparation(current, {
        agentBinding: { kind: 'external', profileId: 'a', alias: 'New' },
      }),
    ).toBe(false);
    expect(
      changesAgentNodePreparation(current, {
        agentBinding: { kind: 'external', profileId: 'b' },
      }),
    ).toBe(true);
    expect(
      changesAgentNodePreparation(
        { agentLaunchOverrides: { workingDirPath: '/work' } },
        { agentLaunchOverrides: null },
      ),
    ).toBe(true);
  });

  it.each(['pdf', 'note', 'question'])(
    'keeps undefined omission scoped to Question edits, not %s metadata',
    (type) => {
      const result = executeCanvasCommands(
        {
          source: 'ui',
          commands: [
            {
              type: 'MERGE_NODE_DATA',
              patches: [
                { nodeId: 'node-test', patch: { coverUrl: undefined } },
              ],
            },
          ],
        },
        {
          canvasId: 'canvas-test',
          nodes: [
            {
              id: 'node-test',
              type,
              position: { x: 0, y: 0 },
              data: { coverUrl: 'cover', label: 'Keep' },
            },
          ],
          edges: [],
        },
      );
      expect(result.writeResult.nodes[0].data.coverUrl).toBe(
        type === 'question' ? 'cover' : undefined,
      );
      expect(result.writeResult.nodes[0].data.label).toBe('Keep');
    },
  );

  it('rejects ordinary FSM merges even when attributed to system', () => {
    for (const source of ['ui', 'agent', 'system'] as const) {
      const output = executeCanvasCommands(
        {
          source,
          commands: [
            {
              type: 'MERGE_NODE_DATA',
              patches: [{ nodeId: 'node-agent', patch: { status: 'running' } }],
            },
          ],
        },
        {
          canvasId: 'canvas-test',
          nodes: [
            {
              id: 'node-agent',
              type: 'question',
              position: { x: 0, y: 0 },
              data,
            },
          ],
          edges: [],
        },
      );
      expect(output.commandResults[0]?.applied).toBe(false);
      expect(output.writeResult.nodes[0]?.data).toEqual(data);
    }
  });

  it('initializes creation instead of copying Bound or invocation metadata', () => {
    const output = executeCanvasCommands(
      {
        source: 'ui',
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: 'node-copy',
                nodeType: 'question',
                position: { x: 0, y: 0 },
                data: {
                  ...data,
                  bindingState: 'bound',
                  status: 'done',
                  threadId: 'thread-copy',
                },
              },
            ],
          },
        ],
      },
      { canvasId: 'canvas-test', nodes: [], edges: [] },
    );
    expect(output.writeResult.nodes[0]?.data).toMatchObject({
      bindingState: 'editing',
      threadId: 'thread-copy',
    });
    expect(output.writeResult.nodes[0]?.data).not.toHaveProperty(
      'invocationToken',
    );
    expect(output.writeResult.nodes[0]?.data).not.toHaveProperty('status');
  });
});
