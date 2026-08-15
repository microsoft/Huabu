// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { validateToolArguments } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import {
  canvasCommandsTool,
  createTaskTool,
  completeTaskRunTool,
  inspectNodesTool,
  snapshotNodesTool,
  startTaskRunTool,
  TOOL_REGISTRY,
} from './definitions.js';

describe('shared Zod tool schemas', () => {
  it('validate canonical canvas commands through pi-ai', () => {
    const result = validateToolArguments(canvasCommandsTool, {
      type: 'toolCall',
      id: 'call-1',
      name: 'space_commands',
      arguments: {
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                nodeType: 'note',
                data: { label: 'Result' },
                position: { x: 10, y: 20 },
              },
            ],
          },
        ],
      },
    });

    expect(result).toMatchObject({
      commands: [{ type: 'CREATE_NODES' }],
    });
  });

  it('rejects commands that violate the canonical contract', () => {
    expect(() =>
      validateToolArguments(canvasCommandsTool, {
        type: 'toolCall',
        id: 'call-2',
        name: 'space_commands',
        arguments: {
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [{ nodeType: 'note' }],
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('does not expose caller-owned content revisions to built-in agents', () => {
    expect(() =>
      validateToolArguments(canvasCommandsTool, {
        type: 'toolCall',
        id: 'call-revision',
        name: 'space_commands',
        arguments: {
          commands: [
            {
              type: 'MERGE_NODE_DATA',
              patches: [
                {
                  nodeId: 'node-1',
                  expectRev: 'copied-revision',
                  patch: { content: 'Bypass attempt' },
                },
              ],
            },
          ],
        },
      }),
    ).toThrow();
    expect(JSON.stringify(canvasCommandsTool.parameters)).not.toContain(
      'expectRev',
    );
  });

  it('preserves field descriptions for the model-facing schema', () => {
    expect(JSON.stringify(canvasCommandsTool.parameters)).toContain(
      'top-left position',
    );
    expect(JSON.stringify(inspectNodesTool.parameters)).toContain(
      'sameParent restricts',
    );
  });

  it('validates shared query limits through pi-ai', () => {
    expect(() =>
      validateToolArguments(inspectNodesTool, {
        type: 'toolCall',
        id: 'call-3',
        name: 'inspect_nodes',
        arguments: { ids: ['node-1'], limit: 201 },
      }),
    ).toThrow();
  });

  it('validates the canonical Task tool contracts', () => {
    expect(TOOL_REGISTRY.create_task).toBe(createTaskTool);
    expect(TOOL_REGISTRY.start_task_run).toBe(startTaskRunTool);
    expect(TOOL_REGISTRY.complete_task_run).toBe(completeTaskRunTool);

    expect(
      validateToolArguments(createTaskTool, {
        type: 'toolCall',
        id: 'call-task-create',
        name: 'create_task',
        arguments: {
          goal: 'Investigate the issue',
          defaultRootProfileId: 'profile-a',
          position: { x: 100, y: 200 },
        },
      }),
    ).toMatchObject({ goal: 'Investigate the issue' });

    expect(
      validateToolArguments(startTaskRunTool, {
        type: 'toolCall',
        id: 'call-run-start',
        name: 'start_task_run',
        arguments: {
          taskId: 'task-a',
          workingDirPath: '/work/task',
        },
      }),
    ).toMatchObject({ taskId: 'task-a' });

    expect(
      validateToolArguments(completeTaskRunTool, {
        type: 'toolCall',
        id: 'call-run-complete',
        name: 'complete_task_run',
        arguments: {
          taskId: 'task-a',
          runId: 'run-a',
          message: 'PR merged',
        },
      }),
    ).toMatchObject({ taskId: 'task-a', runId: 'run-a' });
  });

  it('accepts World targets only on non-materializing read schemas', () => {
    expect(
      validateToolArguments(inspectNodesTool, {
        type: 'toolCall',
        id: 'call-world-read',
        name: 'inspect_nodes',
        arguments: {
          targetCanvasId: 'canvas-source',
          ids: ['node-1'],
        },
      }),
    ).toMatchObject({ targetCanvasId: 'canvas-source' });

    expect(() =>
      validateToolArguments(snapshotNodesTool, {
        type: 'toolCall',
        id: 'call-world-snapshot',
        name: 'snapshot_nodes',
        arguments: {
          targetCanvasId: 'canvas-source',
          nodeIds: ['node-1'],
        },
      }),
    ).toThrow();
  });
});
