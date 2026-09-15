// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./conversation-title.service.js', () => ({
  conversationTitleService: {
    initialize: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  },
}));
vi.mock('./memory/index.js', () => ({ readWorkspaceMemory: () => '' }));
vi.mock('../workspace/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof workspacePaths>()),
  canvasAcpNamespace: (canvasId: string) => ({ name: canvasId }),
}));
vi.mock('./conversation/prompt/build-prompt.js', () => ({
  renderInternalAgentInputs: vi.fn(async () => [
    { type: 'text', text: 'First prompt' },
  ]),
}));
vi.mock('./acp/preprocessor.js', () => ({
  renderExternalAgentInputs: vi.fn(async () => [
    { type: 'text', text: 'First prompt' },
  ]),
}));

import { runAcpAgent } from './acp/service.js';
import { agenetes } from './agenetes/drivers.js';
import { AgentThreadResolver } from './agent-thread-resolver.js';
import { AgentThreadService } from './agent-thread.service.js';
import { runAgent } from './agent.service.js';
import { conversationTitleService } from './conversation-title.service.js';

import type * as workspacePaths from '../workspace/paths.js';
import type { AcpHandle, AcpWorkloadSpec } from './agenetes/drivers.js';
import type { ChatEnvelope } from './conversation/envelope.js';
import type { AgentBinding } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Question ownership at the real message adapters', () => {
  for (const backend of ['internal', 'external'] as const) {
    it.each([
      'selectable',
      'fixed',
      'headless',
      'standalone',
      'standalone-with-anchor',
    ] as const)(`${backend}: %s gates only Chat title work`, async (owner) => {
      const canvasId = owner === 'headless' ? 'source-space' : 'canvas-a';
      const threadId = 'thread-a';
      const questionOwned = !owner.startsWith('standalone');
      const fixed = owner === 'fixed' || owner === 'headless';
      const binding: AgentBinding =
        backend === 'external'
          ? { kind: 'external', alias: 'Agent', profileId: 'profile-a' }
          : { kind: 'internal' };
      const resolver = new AgentThreadResolver({
        readCanvasNodes: async () =>
          questionOwned
            ? [
                {
                  id: 'question-a',
                  type: 'question',
                  data: {
                    threadId,
                    agentBinding: binding,
                    ...(fixed ? { agentBindingPolicy: 'fixed' } : {}),
                  },
                },
              ]
            : [],
        readNodeContent: async () => '',
      });
      const run = vi.fn(async function* () {
        yield { type: 'done' as const, data: { message: 'Done' } };
        return [];
      });
      const handle = {
        run,
        control: vi.fn().mockResolvedValue({ ok: true }),
      } as unknown as AcpHandle;
      const create = vi.spyOn(agenetes, 'create').mockReturnValue(handle);
      vi.spyOn(agenetes, 'get').mockReturnValue(undefined);
      vi.spyOn(agenetes, 'record').mockReturnValue(undefined);
      const startLifecycle = vi.fn().mockResolvedValue(undefined);
      const finishLifecycle = vi.fn().mockResolvedValue(undefined);
      const service = new AgentThreadService({
        resolveAgentNode: resolver.resolveAgentNode.bind(resolver),
        resolveFixedAgentNode: resolver.resolveFixedAgentNode.bind(resolver),
        resolvePersistedExternalBinding: () => null,
        resolvePersistedSpacePrompt: () => ({ realised: false }),
        collectSpacePrompt: vi.fn().mockResolvedValue(null),
        realizeExternal: async ({ requestedBinding, fixedTarget }) => {
          const externalBinding = fixedTarget?.agentBinding ?? requestedBinding;
          if (externalBinding?.kind !== 'external') {
            throw new Error('No binding');
          }
          return {
            binding: externalBinding,
            fixedTarget: fixedTarget ?? null,
            handle,
            spec: {} as AcpWorkloadSpec,
          };
        },
        waitForTurnRelease: vi.fn().mockResolvedValue(undefined),
        acquireTurn: () => vi.fn(),
        startLifecycle,
        finishLifecycle,
        failLifecycle: vi.fn().mockResolvedValue(undefined),
        runExternal: runAcpAgent,
        runInternal: runAgent,
        closeHandle: vi.fn(),
      });
      const envelope: ChatEnvelope = {
        user: { text: 'First prompt', attachments: [] },
        skills: { invokedIds: [], resolved: [] },
        focus: {
          selection: {
            refs: [],
            selectedIds: [],
            imageAttachments: [],
            snapshotAttachments: [],
          },
          ...(owner === 'headless' || owner === 'standalone-with-anchor'
            ? { anchor: { nodeId: 'question-a' } }
            : {}),
        },
      };

      // As in the HTTP path, selectable ownership is resolved by thread,
      // not supplied in the invocation or inferred from the request anchor.
      const invocation = await service.invoke({
        canvasId,
        threadId,
        envelope,
        content: envelope.user.text,
        mode: 'ask',
        requestBinding: binding,
        logger: { warn: vi.fn() } as unknown as FastifyBaseLogger,
      });
      for await (const _event of invocation.events) {
        // Drain the actual adapter, not a mocked dispatch function.
      }

      expect(run).toHaveBeenCalledOnce();
      expect(startLifecycle).toHaveBeenCalledTimes(questionOwned ? 1 : 0);
      expect(finishLifecycle).toHaveBeenCalledTimes(questionOwned ? 1 : 0);
      expect(conversationTitleService.initialize).toHaveBeenCalledTimes(
        questionOwned ? 0 : 1,
      );
      if (!questionOwned) {
        expect(conversationTitleService.initialize).toHaveBeenCalledWith(
          canvasId,
          threadId,
          'First prompt',
        );
        if (backend === 'internal') {
          expect(create.mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(conversationTitleService.initialize).mock
              .invocationCallOrder[0],
          );
        }
      }
    });
  }
});
