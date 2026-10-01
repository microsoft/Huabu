// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { postCanvasExecute, acknowledgeAgentNodeResult } = vi.hoisted(() => ({
  postCanvasExecute: vi.fn(),
  acknowledgeAgentNodeResult: vi.fn(),
}));

vi.mock('@/api/canvas', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  postCanvasExecute,
  acknowledgeAgentNodeResult,
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
  saveConversationDraft,
  awaitConversationDraft,
  acknowledgeConversationResult,
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
  acknowledgeAgentNodeResult
    .mockReset()
    .mockResolvedValue({ acknowledged: true });
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
  it('acknowledges only the observed terminal invocation, never a viewed merge', async () => {
    const view = {
      ...ownerView,
      presentationAnchor: { canvasId: 'canvas-source', nodeId: 'node-source' },
    };
    await acknowledgeConversationResult(view, {
      status: 'running',
      invocationToken: 'run',
    });
    expect(acknowledgeAgentNodeResult).not.toHaveBeenCalled();
    await acknowledgeConversationResult(view, {
      status: 'done',
      invocationToken: 'result',
      viewed: false,
    });
    expect(acknowledgeAgentNodeResult).toHaveBeenCalledWith(
      'canvas-source',
      'node-source',
      { invocationToken: 'result' },
    );
    expect(postCanvasExecute).not.toHaveBeenCalled();
  });

  it('preserves legacy viewed interaction with an explicit absent-token acknowledgement', async () => {
    const view = {
      ...ownerView,
      presentationAnchor: { canvasId: 'canvas-source', nodeId: 'node-source' },
    };
    await acknowledgeConversationResult(view, {
      status: 'done',
      viewed: false,
    });
    expect(acknowledgeAgentNodeResult).toHaveBeenCalledWith(
      'canvas-source',
      'node-source',
      { invocationToken: null },
    );
    expect(postCanvasExecute).not.toHaveBeenCalled();
  });

  it('keeps a rejected draft as a send failure instead of using cached configuration', async () => {
    const view = {
      presentationAnchor: { canvasId: 'draft-failure', nodeId: 'draft-node' },
      conversationOwner: {
        canvasId: 'draft-failure',
        nodeId: 'draft-node',
        threadId: 'draft-thread',
      },
    };
    postCanvasExecute.mockResolvedValueOnce({ results: [{ applied: false }] });
    await expect(
      saveConversationDraft(view, {
        agentBinding: { kind: 'internal' },
        agentMode: 'operate',
      }),
    ).rejects.toThrow('could not be updated');
    await expect(awaitConversationDraft(view)).rejects.toThrow(
      'could not be updated',
    );
  });

  it('uses the acknowledged saved draft after the thread cache is lost', async () => {
    const view = {
      presentationAnchor: {
        canvasId: 'canvas-source',
        nodeId: 'node-saved-draft',
      },
      conversationOwner: {
        canvasId: 'canvas-source',
        nodeId: 'node-saved-draft',
        threadId: 'thread-draft',
      },
    };
    const binding = {
      kind: 'external' as const,
      profileId: 'chosen',
      alias: 'Chosen',
    };
    const before = {
      id: 'node-saved-draft',
      type: 'question',
      position: { x: 0, y: 0 },
      data: {
        type: 'question',
        threadId: 'thread-draft',
        bindingState: 'editing',
      },
    };
    const after = {
      ...before,
      data: { ...before.data, agentBinding: binding, agentMode: 'ask' },
    };
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'canvas-source',
      version: 1,
      nodes: [before],
      isLoading: true,
    });
    postCanvasExecute.mockResolvedValueOnce({
      canvasId: 'canvas-source',
      fromVersion: 1,
      toVersion: 2,
      deltas: [{ type: 'REPLACE_NODE', prev: before, next: after }],
      results: [{ applied: true }],
      pendingEffects: {
        mutatedNodes: [],
        deletedNodeIds: [],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      },
    });
    await saveConversationDraft(view, {
      agentBinding: binding,
      agentMode: 'ask',
    });
    await awaitConversationDraft(view);
    expect(
      resolveConversationAgentBinding(useCanvasStore.getState().nodes[0].data, {
        kind: 'internal',
      }),
    ).toEqual(binding);
    expect(
      postCanvasExecute.mock.calls[0][1].commands[0].patches[0].patch,
    ).toEqual({
      agentBinding: binding,
      agentMode: 'ask',
    });
  });

  it('waits for actual creation application before sending the initial draft', async () => {
    const view = {
      presentationAnchor: { canvasId: 'create-canvas', nodeId: 'node-create' },
      conversationOwner: {
        canvasId: 'create-canvas',
        nodeId: 'node-create',
        threadId: 'create-thread',
      },
    };
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'create-canvas',
      nodes: [],
      edges: [],
      version: 1,
      isLoading: true,
    });
    let rejectCreation: ((error: Error) => void) | undefined;
    postCanvasExecute.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCreation = reject;
        }),
    );
    useCanvasStore.getState().executeCommands([
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-create',
            nodeType: 'question',
            position: { x: 0, y: 0 },
            data: { threadId: 'create-thread' },
          },
        ],
      },
    ]);
    const draft = saveConversationDraft(view, {
      agentBinding: { kind: 'internal' },
      agentMode: 'operate',
    });
    await vi.waitFor(() => expect(postCanvasExecute).toHaveBeenCalledTimes(1));
    expect(postCanvasExecute.mock.calls[0][1].commands[0].type).toBe(
      'CREATE_NODES',
    );
    rejectCreation?.(new Error('creation failed'));
    await expect(draft).rejects.toThrow('creation failed');
    expect(postCanvasExecute).toHaveBeenCalledTimes(1);
  });

  it('rejects acknowledgement of a draft superseded by newer server selection', async () => {
    const view = {
      presentationAnchor: { canvasId: 'draft-conflict', nodeId: 'draft-node' },
      conversationOwner: {
        canvasId: 'draft-conflict',
        nodeId: 'draft-node',
        threadId: 'draft-thread',
      },
    };
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'draft-conflict',
      version: 3,
      nodes: [
        {
          id: 'draft-node',
          type: 'question',
          position: { x: 0, y: 0 },
          data: {
            agentBinding: { kind: 'external', profileId: 'new', alias: 'New' },
            agentMode: 'ask',
          },
        },
      ],
    });
    await expect(
      saveConversationDraft(view, {
        agentBinding: { kind: 'internal' },
        agentMode: 'operate',
      }),
    ).rejects.toThrow('selection changed');
  });

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

  it('omits server-owned fields regardless of binding policy', () => {
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
    ).toEqual({ content: 'Prompt' });
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
    ).toBeNull();
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
      agentMode: 'operate',
    });

    expect(useCanvasStore.getState().nodes[0]).toBe(before);
    expect(postCanvasExecute).toHaveBeenCalledWith('canvas-source', {
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            {
              nodeId: 'node-source',
              patch: { agentMode: 'operate' },
            },
          ],
        },
      ],
      originator: { source: 'ui' },
    });
  });

  it('rejects browser lifecycle writes without optimistic mutation', async () => {
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

    await expect(
      patchConversationOwnerNode(view, { status: 'running' }),
    ).rejects.toThrow('server-owned');

    expect(useCanvasStore.getState().nodes[0]?.data.status).toBe('idle');
    expect(postCanvasExecute).not.toHaveBeenCalled();
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

    await patchConversationOwnerNode(ownerView, { agentMode: 'operate' });

    expect(useCanvasStore.getState().version).toBe(2);
    expect(useCanvasStore.getState().nodes[0]?.data.status).toBe('running');
  });

  it('serializes draft writes for the same source owner', async () => {
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

    const done = patchConversationOwnerNode(ownerView, { agentMode: 'ask' });
    const running = patchConversationOwnerNode(ownerView, {
      agentMode: 'operate',
    });
    await vi.waitFor(() => expect(postCanvasExecute).toHaveBeenCalledTimes(1));

    releaseFirst?.();
    await Promise.all([done, running]);

    expect(postCanvasExecute).toHaveBeenCalledTimes(2);
    expect(postCanvasExecute.mock.calls[1]?.[1]).toMatchObject({
      commands: [
        {
          patches: [{ patch: { agentMode: 'operate' } }],
        },
      ],
    });
  });

  it('does not replay a delayed command patch after a newer SSE update', async () => {
    const view = {
      ...ownerView,
      presentationAnchor: { canvasId: 'canvas-source', nodeId: 'node-source' },
    };
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'canvas-source',
      version: 3,
      nodes: [
        {
          id: 'node-source',
          type: 'question',
          position: { x: 0, y: 0 },
          data: {
            type: 'question',
            agentMode: 'operate',
            bindingState: 'bound',
            invocationToken: 'new',
          },
        },
      ],
    });
    await patchConversationOwnerNode(view, { agentMode: 'ask' });
    expect(useCanvasStore.getState().version).toBe(3);
    expect(useCanvasStore.getState().nodes[0]?.data).toMatchObject({
      agentMode: 'operate',
      bindingState: 'bound',
      invocationToken: 'new',
    });
  });
});
