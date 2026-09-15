// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { postCanvasExecute } = vi.hoisted(() => ({
  postCanvasExecute: vi.fn(),
}));

vi.mock('@/api/canvas', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  postCanvasExecute,
}));

import useCanvasStore from './canvasStore';
import { useChatStore } from './chatStore';
import {
  ConversationIntegrityError,
  conversationRequestScope,
  conversationViewForNode,
  filterClientOwnedQuestionPatch,
  patchConversationOwnerNode,
  resolveConversationAgentBinding,
  resolveConversationOwnerSource,
  shouldComposeConversationOwner,
  validateConversationView,
} from './conversationOwner';

import type * as CanvasApi from '@/api/canvas';
import type { AgentConversationView } from '@huabu/shared';

const ownerView: AgentConversationView = {
  presentationAnchor: {
    canvasId: 'canvas-source',
    nodeId: 'node-source',
  },
  conversationOwner: {
    canvasId: 'canvas-source',
    nodeId: 'node-source',
    threadId: 'thread-source',
  },
};

beforeEach(() => {
  useChatStore.persist.setOptions({
    storage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
  postCanvasExecute.mockReset();
  postCanvasExecute.mockResolvedValue({
    canvasId: 'canvas-source',
    fromVersion: 1,
    toVersion: 2,
    deltas: [],
    results: [{ command: {}, applied: true }],
    commands: [],
    pendingEffects: {
      mutatedNodes: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    },
  });
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'canvas-source',
    version: 1,
    nodes: [
      {
        id: 'node-source',
        type: 'question',
        position: { x: 0, y: 0 },
        data: {
          type: 'question',
          threadId: 'thread-source',
          content: '',
          status: 'idle',
        },
      },
    ],
    edges: [],
  });
  useChatStore.setState({
    threadsById: {},
  });
});

describe('conversation owner routing', () => {
  it('uses the durable owner binding when a refreshed send still has the cache default', () => {
    const externalBinding = {
      kind: 'external' as const,
      alias: 'Copilot',
      profileId: 'profile-copilot',
    };

    expect(
      resolveConversationAgentBinding(
        { agentBinding: externalBinding },
        { kind: 'internal' },
      ),
    ).toEqual(externalBinding);
    expect(
      resolveConversationAgentBinding(undefined, { kind: 'internal' }),
    ).toEqual({ kind: 'internal' });
  });

  it('limits fixed Agent Node client patches to viewed state', () => {
    expect(
      filterClientOwnedQuestionPatch(
        { agentBindingPolicy: 'fixed' },
        {
          content: 'Prompt',
          status: 'running',
          errorMessage: undefined,
          viewed: false,
        },
      ),
    ).toEqual({ viewed: false });
    expect(
      filterClientOwnedQuestionPatch(
        { agentBindingPolicy: 'fixed' },
        { status: 'done' },
      ),
    ).toBeNull();
    expect(
      filterClientOwnedQuestionPatch(
        { agentBindingPolicy: 'selectable' },
        { status: 'done' },
      ),
    ).toEqual({ status: 'done' });
  });

  it('routes ordinary Question and unbound Chat requests with Canvas selection', () => {
    expect(conversationRequestScope(ownerView, 'canvas-source')).toEqual({
      canvasId: 'canvas-source',
      anchorNodeId: 'node-source',
      includeCanvasSelection: true,
    });
    expect(conversationRequestScope(null, 'canvas-source')).toEqual({
      canvasId: 'canvas-source',
      includeCanvasSelection: true,
    });
  });

  it('persists a background lifecycle update without patching a different active Canvas', async () => {
    useCanvasStore.getState()._setStateNoAutosave({ canvasId: 'canvas-other' });
    const before = useCanvasStore.getState().nodes[0];

    await patchConversationOwnerNode(ownerView, {
      status: 'running',
      viewed: false,
    });

    expect(useCanvasStore.getState().nodes[0]).toBe(before);
    expect(postCanvasExecute).toHaveBeenCalledWith('canvas-source', {
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            {
              nodeId: 'node-source',
              patch: { status: 'running', viewed: false },
            },
          ],
        },
      ],
      originator: { source: 'ui' },
    });
  });

  it('persists ordinary same-Canvas question lifecycle updates', async () => {
    const view: AgentConversationView = {
      presentationAnchor: {
        canvasId: 'canvas-source',
        nodeId: 'node-source',
      },
      conversationOwner: {
        canvasId: 'canvas-source',
        nodeId: 'node-source',
        threadId: 'thread-source',
      },
    };
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'canvas-source',
      nodes: [
        {
          id: 'node-source',
          type: 'question',
          position: { x: 0, y: 0 },
          data: { type: 'question', content: '', status: 'idle' },
        },
      ],
    });

    await patchConversationOwnerNode(view, { status: 'running' });

    expect(useCanvasStore.getState().nodes[0]?.data.status).toBe('running');
    expect(postCanvasExecute).toHaveBeenCalledWith('canvas-source', {
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'node-source', patch: { status: 'running' } }],
        },
      ],
      originator: { source: 'ui' },
    });
  });

  it('resolves only ordinary Question nodes with a thread', () => {
    const node = useCanvasStore.getState().nodes[0];
    expect(conversationViewForNode(node, 'canvas-source')).toEqual(ownerView);
    expect(
      conversationViewForNode({ ...node, data: {} }, 'canvas-source'),
    ).toBeNull();
    expect(
      conversationViewForNode({ ...node, type: 'note' }, 'canvas-source'),
    ).toBeNull();
    expect(
      resolveConversationOwnerSource('canvas-source', [node], ownerView),
    ).toBe(node.data);
    expect(
      resolveConversationOwnerSource('canvas-other', [node], ownerView),
    ).toBeUndefined();
  });

  it('does not compose over authored source content with stale idle status', () => {
    expect(
      shouldComposeConversationOwner({
        status: 'idle',
        content: 'Existing question',
      }),
    ).toBe(false);
    expect(
      shouldComposeConversationOwner({ status: 'idle', content: '' }),
    ).toBe(true);
  });

  it('validates the current owner and rejects stale thread identity', async () => {
    await expect(validateConversationView(ownerView)).resolves.toBeUndefined();
    useCanvasStore
      .getState()
      .patchNodeSilent('node-source', { threadId: 'thread-replaced' });
    await expect(validateConversationView(ownerView)).rejects.toThrow(
      ConversationIntegrityError,
    );
    expect(postCanvasExecute).not.toHaveBeenCalled();
  });

  it('rejects a deleted owner or a different active Canvas', async () => {
    useCanvasStore.getState()._setStateNoAutosave({ canvasId: 'canvas-other' });
    await expect(validateConversationView(ownerView)).rejects.toThrow(
      ConversationIntegrityError,
    );
    useCanvasStore
      .getState()
      ._setStateNoAutosave({ canvasId: 'canvas-source', nodes: [] });
    await expect(validateConversationView(ownerView)).rejects.toThrow(
      ConversationIntegrityError,
    );
  });

  it('reconciles a routed lifecycle response when its source becomes active', async () => {
    useCanvasStore.getState()._setStateNoAutosave({ canvasId: 'canvas-other' });
    postCanvasExecute.mockImplementationOnce(async () => {
      useCanvasStore.getState()._setStateNoAutosave({
        canvasId: 'canvas-source',
        version: 1,
        nodes: [
          {
            id: 'node-source',
            type: 'question',
            position: { x: 0, y: 0 },
            data: { type: 'question', status: 'idle' },
          },
        ],
      });
      return {
        canvasId: 'canvas-source',
        fromVersion: 1,
        toVersion: 2,
        deltas: [
          {
            type: 'REPLACE_NODE' as const,
            prev: {
              id: 'node-source',
              type: 'question',
              position: { x: 0, y: 0 },
              data: { type: 'question', status: 'idle' },
            },
            next: {
              id: 'node-source',
              type: 'question',
              position: { x: 0, y: 0 },
              data: { type: 'question', status: 'running' },
            },
          },
        ],
        results: [{ command: {}, applied: true }],
        commands: [],
        pendingEffects: {
          mutatedNodes: [],
          deletedNodeIds: [],
          contentEditedNodeIds: [],
          deferredFitFrameIds: [],
        },
      };
    });

    await patchConversationOwnerNode(ownerView, { status: 'running' });

    expect(useCanvasStore.getState().version).toBe(2);
    expect(useCanvasStore.getState().nodes[0]?.data.status).toBe('running');
  });

  it('serializes lifecycle writes for the same source owner', async () => {
    let releaseFirst: (() => void) | undefined;
    postCanvasExecute
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () =>
              resolve({
                canvasId: 'canvas-source',
                fromVersion: 1,
                toVersion: 2,
                deltas: [],
                results: [{ command: {}, applied: true }],
                commands: [],
                pendingEffects: {
                  mutatedNodes: [],
                  deletedNodeIds: [],
                  contentEditedNodeIds: [],
                  deferredFitFrameIds: [],
                },
              });
          }),
      )
      .mockResolvedValueOnce({
        canvasId: 'canvas-source',
        fromVersion: 2,
        toVersion: 3,
        deltas: [],
        results: [{ command: {}, applied: true }],
        commands: [],
        pendingEffects: {
          mutatedNodes: [],
          deletedNodeIds: [],
          contentEditedNodeIds: [],
          deferredFitFrameIds: [],
        },
      });

    const done = patchConversationOwnerNode(ownerView, { status: 'done' });
    const running = patchConversationOwnerNode(ownerView, {
      status: 'running',
    });
    await vi.waitFor(() => expect(postCanvasExecute).toHaveBeenCalledTimes(1));

    releaseFirst?.();
    await Promise.all([done, running]);

    expect(postCanvasExecute).toHaveBeenCalledTimes(2);
    expect(postCanvasExecute.mock.calls[1]?.[1]).toMatchObject({
      commands: [
        {
          patches: [{ patch: { status: 'running' } }],
        },
      ],
    });
  });
});
