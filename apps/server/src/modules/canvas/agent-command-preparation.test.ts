// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { prepareAgentCanvasCommands } from './agent-command-preparation.js';

describe('prepareAgentCanvasCommands', () => {
  it('stamps server-owned authorship metadata', () => {
    const [create, connect] = prepareAgentCanvasCommands([
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'note',
            data: { label: 'Created' },
            position: { x: 0, y: 0 },
          },
        ],
      },
      {
        type: 'CONNECT_NODES',
        edges: [
          {
            source: 'node-1',
            target: 'node-2',
            style: { label: 'supports' },
          },
        ],
      },
    ]);

    expect(create).toMatchObject({
      nodes: [
        {
          data: {
            origin: { type: 'ai-operate' },
            labelSource: 'agent',
          },
        },
      ],
    });
    expect(connect).toMatchObject({
      edges: [{ style: { labelSource: 'agent' } }],
    });
  });

  it('uses built-in read-set revisions and ignores caller-supplied ones', () => {
    const [command] = prepareAgentCanvasCommands(
      [
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            { nodeId: 'node-1', patch: { content: 'one' } },
            {
              nodeId: 'node-2',
              expectRev: 'explicit',
              patch: { content: 'two' },
            },
          ],
        },
      ],
      { readSet: new Map([['node-1', 'from-read-set']]) },
    );

    expect(command).toMatchObject({
      patches: [{ expectRev: 'from-read-set' }, {}],
    });
    expect(command).toHaveProperty('type', 'MERGE_NODE_DATA');
    if (command?.type !== 'MERGE_NODE_DATA') {
      throw new Error('Expected MERGE_NODE_DATA');
    }
    expect(command.patches[1]).not.toHaveProperty('expectRev');
  });

  it('allows direct RFS callers to supply revisions explicitly', () => {
    const [command] = prepareAgentCanvasCommands(
      [
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            {
              nodeId: 'node-1',
              expectRev: 'explicit',
              patch: { content: 'one' },
            },
          ],
        },
      ],
      { allowCallerRevisions: true },
    );

    expect(command).toMatchObject({
      patches: [{ expectRev: 'explicit' }],
    });
  });
});
