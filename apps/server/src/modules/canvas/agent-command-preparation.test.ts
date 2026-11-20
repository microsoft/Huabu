// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { createNodesCommandSchema, type CanvasNodeId } from '@huabu/shared';
import {
  autoHeightKey,
  executeCanvasCommands,
} from '@huabu/shared/canvas-engine';

import { prepareAgentCanvasCommands } from './agent-command-preparation.js';

describe('prepareAgentCanvasCommands', () => {
  it.each([
    { height: 'auto', mode: 'auto', expectedHeight: 52 },
    { height: 180, mode: 'fixed', expectedHeight: 180 },
    { height: undefined, mode: 'fixed', expectedHeight: 300 },
  ] as const)(
    'preserves wire creation height $height through execution',
    ({ height, mode, expectedHeight }) => {
      const wire = createNodesCommandSchema.parse({
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'note',
            position: { x: 10, y: 20 },
            size: { width: 560, ...(height === undefined ? {} : { height }) },
            data: { content: 'Auto height remains measurable.' },
          },
        ],
      });
      const commands = prepareAgentCanvasCommands([wire]);
      const nodes = executeCanvasCommands(
        { source: 'agent', commands },
        { nodes: [], edges: [], canvasId: 'canvas' },
      ).writeResult.nodes;
      const note = nodes[0];
      expect(note.data.heightMode).toBe(mode);
      expect(note.style).toEqual({ width: 560, height: expectedHeight });
      const measured = executeCanvasCommands(
        {
          source: 'system',
          commands: [
            {
              type: 'APPLY_MEASURED_HEIGHT',
              items: [
                {
                  nodeId: note.id as CanvasNodeId,
                  intrinsicHeight: 420,
                  measuredFor: autoHeightKey(note),
                },
              ],
            },
          ],
        },
        { nodes, edges: [], canvasId: 'canvas' },
      ).writeResult.nodes[0];
      expect(measured.style?.height).toBe(
        mode === 'auto' ? 424 : expectedHeight,
      );
    },
  );

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

  it('injects no revision for a property patch and none for an unread body write', () => {
    const [command] = prepareAgentCanvasCommands(
      [
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            { nodeId: 'node-1', patch: { properties: { year: 2026 } } },
            { nodeId: 'node-1', patch: { content: 'unread body' } },
            { nodeId: 'node-1', patch: { content: 'unread notes' } },
          ],
        },
      ],
      { readSet: new Map([['node-2', 'read']]) },
    );
    if (command.type !== 'MERGE_NODE_DATA') throw new Error('Expected merge');
    expect(command.patches[0].expectRev).toBeUndefined();
    expect(command.patches[1].expectRev).toBeUndefined();
    expect(command.patches[2].expectRev).toBeUndefined();
  });

  it('injects no revision for a property patch of a node that was read, and keeps a caller revision it is given', () => {
    const patches = [
      { nodeId: 'node-1', patch: { properties: { year: 2026 } } },
      {
        nodeId: 'node-1',
        expectRev: 'from-an-older-prompt',
        patch: { propertyDisplayKeys: ['year'] },
      },
      {
        nodeId: 'node-1',
        patch: { content: 'body', properties: { year: 2027 } },
      },
    ];
    const [builtIn] = prepareAgentCanvasCommands(
      [{ type: 'MERGE_NODE_DATA', patches }],
      { readSet: new Map([['node-1', 'read']]) },
    );
    if (builtIn.type !== 'MERGE_NODE_DATA') throw new Error('Expected merge');
    expect(builtIn.patches[0].expectRev).toBeUndefined();
    expect(builtIn.patches[1].expectRev).toBeUndefined();
    // A patch that also rewrites the body carries the body's revision.
    expect(builtIn.patches[2].expectRev).toBe('read');

    // A native caller's revision on a properties-only patch is passed on;
    // the executor does not look at it.
    const [native] = prepareAgentCanvasCommands(
      [{ type: 'MERGE_NODE_DATA', patches }],
      { allowCallerRevisions: true },
    );
    if (native.type !== 'MERGE_NODE_DATA') throw new Error('Expected merge');
    expect(native.patches[1].expectRev).toBe('from-an-older-prompt');
  });

  it('unwraps a downloaded node sidecar before writing its body back', () => {
    const [command] = prepareAgentCanvasCommands([
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          {
            nodeId: 'node-1',
            patch: {
              content:
                '---\nid: node-1\ntype: note\nlabel: Example\n---\n# Updated body',
            },
          },
        ],
      },
    ]);

    expect(command).toHaveProperty('patches.0.patch.content', '# Updated body');
  });

  it('preserves frontmatter-like content that is not the target sidecar', () => {
    const content = '---\ntitle: Example\n---\n# Body';
    const [command] = prepareAgentCanvasCommands([
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'node-1', patch: { content } }],
      },
    ]);

    expect(command).toHaveProperty('patches.0.patch.content', content);
  });

  it.each([
    '---\nid: node-2\ntype: note\n---\n# Different node',
    '---\nid: [unterminated\n---\n# Malformed YAML',
  ])('preserves unsafe sidecar candidate %j', (content) => {
    const [command] = prepareAgentCanvasCommands([
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'node-1', patch: { content } }],
      },
    ]);

    expect(command).toHaveProperty('patches.0.patch.content', content);
  });
});
