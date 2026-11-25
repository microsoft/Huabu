// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import resolvePasteClipboard from '../resolvePasteClipboard';

import type { CanvasNode } from '@/components/Nodes/types';

describe('resolvePasteClipboard interactiveView & data-node remapping', () => {
  it('remaps bound data-node and canvas.nodes IDs when pasted together and clears duplicate viewKey', () => {
    const existingWebNode = {
      id: 'node-existing-web',
      type: 'web',
      position: { x: 0, y: 0 },
      style: { width: 480, height: 360 },
      data: {
        label: 'Config Form',
        src: 'artifact-form.html',
        viewKey: 'tracker-config-form',
        interactiveView: {
          protocolVersion: 1,
          state: { schema: { type: 'null' }, value: null },
          bindings: [
            {
              bindingId: 'cfg',
              source: { kind: 'data-node', nodeId: 'node-orig-data' },
            },
            {
              bindingId: 'refs',
              source: {
                kind: 'canvas.nodes',
                nodeIds: ['node-orig-data', 'node-outside-clipboard'],
              },
            },
          ],
          actions: [
            {
              actionId: 'save',
              kind: 'data.replace',
              bindingId: 'cfg',
            },
          ],
        },
      },
    } as unknown as CanvasNode;

    const origDataNode = {
      id: 'node-orig-data',
      type: 'data',
      position: { x: 520, y: 0 },
      style: { width: 320, height: 220 },
      data: {
        label: 'Config Data',
        content: '{"repo":"microsoft/Huabu"}',
        dataSchema: {
          type: 'object',
          properties: { repo: { type: 'string' } },
          required: ['repo'],
          additionalProperties: false,
        },
      },
    } as unknown as CanvasNode;

    const resolution = resolvePasteClipboard(
      {
        type: 'PASTE_CLIPBOARD',
        clipboardNodes: [existingWebNode, origDataNode],
        clipboardEdges: [],
      },
      {
        nodes: [existingWebNode, origDataNode],
        edges: [],
      },
    );

    const createCmd = resolution.commands.find(
      (cmd) => cmd.type === 'CREATE_NODES',
    );
    expect(createCmd?.type).toBe('CREATE_NODES');
    if (createCmd?.type !== 'CREATE_NODES') return;

    const pastedWeb = createCmd.nodes.find((n) => n.nodeType === 'web');
    const pastedData = createCmd.nodes.find((n) => n.nodeType === 'data');
    expect(pastedWeb).toBeDefined();
    expect(pastedData).toBeDefined();
    expect(pastedData?.id).not.toBe('node-orig-data');
    expect(pastedData?.data?.dataSchema).toEqual({
      type: 'object',
      properties: { repo: { type: 'string' } },
      required: ['repo'],
      additionalProperties: false,
    });

    expect((pastedWeb?.data as { viewKey?: string })?.viewKey).toBeUndefined();
    const pastedIv = pastedWeb?.data?.interactiveView;
    expect(pastedIv?.bindings[0]).toEqual({
      bindingId: 'cfg',
      source: { kind: 'data-node', nodeId: pastedData?.id },
    });
    expect(pastedIv?.bindings[1]).toEqual({
      bindingId: 'refs',
      source: {
        kind: 'canvas.nodes',
        nodeIds: [pastedData?.id, 'node-outside-clipboard'],
      },
    });
  });
});
