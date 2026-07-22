import { validateToolArguments } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { canvasCommandsTool, inspectNodesTool } from './definitions.js';

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
});
