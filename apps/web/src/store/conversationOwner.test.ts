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

import { canvasSyncTabId } from './canvasCommitSync';
import useCanvasStore from './canvasStore';
import { useChatStore } from './chatStore';
import {
  ConversationIntegrityError,
  conversationRequestScope,
  conversationViewFromWorldReference,
  filterClientOwnedQuestionPatch,
  patchConversationOwnerNode,
  shouldComposeConversationOwner,
  validateConversationView,
} from './conversationOwner';

import type * as CanvasApi from '@/api/canvas';
import type { AgentConversationView } from '@huabu/shared';

const worldView: AgentConversationView = {
  presentationAnchor: {
    canvasId: 'canvas-world',
    nodeId: 'node-ref-source',
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
    canvasId: 'canvas-world',
    nodes: [
      {
        id: 'node-ref-source',
        type: 'nodeRef',
        position: { x: 0, y: 0 },
        data: {
          type: 'nodeRef',
          target: { canvasId: 'canvas-source', nodeId: 'node-source' },
        },
      },
    ],
    edges: [],
  });
  useChatStore.setState({
    threadId: 'thread-world',
    viewingQuestionThread: null,
    loadingThreadIds: new Set(),
    questionReplayByCanvas: {},
  });
});

describe('conversation owner routing', () => {
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

  it('routes headless requests to the source owner without World selection', () => {
    expect(conversationRequestScope(worldView, 'canvas-world')).toEqual({
      canvasId: 'canvas-source',
      anchorNodeId: 'node-source',
      includeCanvasSelection: false,
    });
  });

  it('mutates a headless source through the server without patching World', async () => {
    const before = useCanvasStore.getState().nodes[0];

    await patchConversationOwnerNode(worldView, {
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
      originator: { source: 'ui', tabId: canvasSyncTabId },
    });
  });

  it('keeps ordinary same-Canvas question lifecycle updates local', async () => {
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
    expect(postCanvasExecute).not.toHaveBeenCalled();
  });

  it('rejects a resolved source question that has no thread', () => {
    expect(() =>
      conversationViewFromWorldReference('canvas-world', 'node-ref-source', {
        kind: 'nodeRef',
        referenceNodeId: 'node-ref-source',
        target: { canvasId: 'canvas-source', nodeId: 'node-source' },
        status: 'ok',
        source: {
          type: 'question',
          status: 'idle',
          viewed: false,
          agentMode: 'ask',
          agentBinding: { kind: 'internal' },
        },
      }),
    ).toThrow(ConversationIntegrityError);
  });

  it('does not compose over authored source content with stale idle status', () => {
    expect(
      shouldComposeConversationOwner(
        { status: 'idle', hasAuthoredContent: true },
        true,
      ),
    ).toBe(false);
    expect(
      shouldComposeConversationOwner(
        { status: 'idle', hasAuthoredContent: false },
        true,
      ),
    ).toBe(true);
  });

  it('rejects a stale headless owner after refreshing World references', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      worldReferences: {
        'node-ref-source': {
          kind: 'nodeRef',
          referenceNodeId: 'node-ref-source',
          target: { canvasId: 'canvas-source', nodeId: 'node-source' },
          status: 'ok',
          source: {
            type: 'question',
            threadId: 'thread-replaced',
            status: 'idle',
            viewed: false,
            agentMode: 'ask',
            agentBinding: { kind: 'internal' },
          },
        },
      },
    });
    const refresh = vi
      .spyOn(useCanvasStore.getState(), 'refreshWorldReferences')
      .mockResolvedValue();

    await expect(validateConversationView(worldView)).rejects.toThrow(
      ConversationIntegrityError,
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('reconciles a routed lifecycle response when its source becomes active', async () => {
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

    await patchConversationOwnerNode(worldView, { status: 'running' });

    expect(useCanvasStore.getState().version).toBe(2);
    expect(useCanvasStore.getState().nodes[0]?.data.status).toBe('running');
  });

  it('switches foreground owners without stopping an existing run', () => {
    useChatStore
      .getState()
      .openQuestionThread(worldView, { kind: 'internal' }, 'canvas-world');
    useChatStore.getState().setThreadLoading('thread-source', true);

    const second: AgentConversationView = {
      presentationAnchor: {
        canvasId: 'canvas-world',
        nodeId: 'node-ref-second',
      },
      conversationOwner: {
        canvasId: 'canvas-second',
        nodeId: 'node-second',
        threadId: 'thread-second',
      },
    };
    useChatStore
      .getState()
      .openQuestionThread(second, { kind: 'internal' }, 'canvas-world');

    const state = useChatStore.getState();
    expect(state.threadId).toBe('thread-second');
    expect(state.viewingQuestionThread?.conversationOwner).toEqual(
      second.conversationOwner,
    );
    expect(state.loadingThreadIds.has('thread-source')).toBe(true);
  });

  it('preserves the owner Canvas chat when moving a headless replay into it', () => {
    useChatStore.setState({
      threadMap: {
        'canvas-world': 'thread-world',
        'canvas-source': 'thread-source-canvas',
      },
      bindingMap: {
        'canvas-world': { kind: 'internal' },
        'canvas-source': {
          kind: 'external',
          profileId: 'profile-source',
          alias: 'Source Agent',
        },
      },
      lastAction: 'operate',
    });
    useChatStore
      .getState()
      .openQuestionThread(worldView, { kind: 'internal' }, 'canvas-world');

    useChatStore
      .getState()
      .openQuestionThreadInOwnerCanvas(worldView, { kind: 'internal' });
    useChatStore.getState().switchToCanvas('canvas-source');
    useChatStore.getState().closeQuestionThread('canvas-source');

    const state = useChatStore.getState();
    expect(state.threadId).toBe('thread-source-canvas');
    expect(state.threadMap['canvas-source']).toBe('thread-source-canvas');
    expect(state.agentBinding).toEqual({
      kind: 'external',
      profileId: 'profile-source',
      alias: 'Source Agent',
    });
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

    const done = patchConversationOwnerNode(worldView, { status: 'done' });
    const running = patchConversationOwnerNode(worldView, {
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
