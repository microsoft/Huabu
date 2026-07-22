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

  it('injects built-in agent read-set revisions without replacing explicit ones', () => {
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
      patches: [{ expectRev: 'from-read-set' }, { expectRev: 'explicit' }],
    });
  });
});
