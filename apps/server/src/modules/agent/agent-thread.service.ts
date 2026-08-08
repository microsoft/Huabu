// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { emptyAcpOverlay } from '@agenetes/acp-driver';

import { AGENT_SSE_EVENTS } from '@huabu/shared';

import { runAcpAgent } from './acp/service.js';
import { agenetes } from './agenetes/drivers.js';
import { agentNodeLifecycle } from './agent-node-lifecycle.js';
import {
  agentThreadResolver,
  type FixedAgentNodeTarget,
} from './agent-thread-resolver.js';
import { runAgent } from './agent.service.js';
import { envelopeHasImage } from './conversation/envelope.js';
import { readWorkspaceMemory } from './memory/index.js';
import { planSkillDispatch } from './skill-model-routing.js';
import { acquireAgentTurn, waitForAgentTurnRelease } from './turn-lease.js';
import { loadAgent } from '../../prompt/index.js';

import type { ChatEnvelope } from './conversation/envelope.js';
import type {
  AgentBinding,
  AgentMode,
  AgentStreamEvent,
  ReasoningEffort,
} from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

interface AgentThreadServiceDependencies {
  resolveFixedAgentNode: (
    canvasId: string,
    threadId: string,
  ) => FixedAgentNodeTarget | null;
  waitForTurnRelease: typeof waitForAgentTurnRelease;
  acquireTurn: typeof acquireAgentTurn;
  startLifecycle: typeof agentNodeLifecycle.start;
  finishLifecycle: typeof agentNodeLifecycle.done;
  failLifecycle: typeof agentNodeLifecycle.error;
  runExternal: typeof runAcpAgent;
  runInternal: typeof runAgent;
  closeHandle: (threadId: string) => void;
}

const DEFAULT_DEPENDENCIES: AgentThreadServiceDependencies = {
  resolveFixedAgentNode: (canvasId, threadId) =>
    agentThreadResolver.resolveFixedAgentNode(canvasId, threadId),
  waitForTurnRelease: waitForAgentTurnRelease,
  acquireTurn: acquireAgentTurn,
  startLifecycle: agentNodeLifecycle.start.bind(agentNodeLifecycle),
  finishLifecycle: agentNodeLifecycle.done.bind(agentNodeLifecycle),
  failLifecycle: agentNodeLifecycle.error.bind(agentNodeLifecycle),
  runExternal: runAcpAgent,
  runInternal: runAgent,
  closeHandle: (threadId) => agenetes.close(threadId),
};

export class AgentThreadBusyError extends Error {
  constructor(threadId: string) {
    super(`Another turn is already running for thread ${threadId}`);
    this.name = 'AgentThreadBusyError';
  }
}

export interface AgentThreadInvocationOptions {
  threadId: string;
  canvasId?: string;
  content: string;
  mode: AgentMode;
  envelope: ChatEnvelope;
  requestBinding?: AgentBinding;
  fixedTarget?: FixedAgentNodeTarget | null;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  signal: AbortSignal;
  logger: FastifyBaseLogger;
  debugPrompt?: {
    turnNumber: number;
    threadId: string;
    mode: string;
    logger: FastifyBaseLogger;
  };
}

export interface AgentThreadInvocation {
  binding: AgentBinding;
  fixedTarget: FixedAgentNodeTarget | null;
  events: AsyncGenerator<AgentStreamEvent, void>;
  dispose: (error?: unknown) => Promise<void>;
}

function buildAgentSystemPrompt(params: {
  canvasId: string | undefined;
  mode: Parameters<typeof loadAgent>[0];
}): string {
  const agentCfg = loadAgent(params.mode, { canvasId: params.canvasId });
  const workspaceMemory = readWorkspaceMemory();
  return workspaceMemory
    ? `${agentCfg.systemPrompt}\n\n<workspace_memory>\n${workspaceMemory}\n</workspace_memory>`
    : agentCfg.systemPrompt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Internal Error';
}

export class AgentThreadService {
  constructor(
    private readonly dependencies: AgentThreadServiceDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  resolveFixedTarget(
    canvasId: string | undefined,
    threadId: string,
  ): FixedAgentNodeTarget | null {
    return canvasId
      ? this.dependencies.resolveFixedAgentNode(canvasId, threadId)
      : null;
  }

  async invoke(
    options: AgentThreadInvocationOptions,
  ): Promise<AgentThreadInvocation> {
    const fixedTarget =
      options.fixedTarget === undefined
        ? this.resolveFixedTarget(options.canvasId, options.threadId)
        : options.fixedTarget;
    const binding: AgentBinding = fixedTarget?.agentBinding ??
      options.requestBinding ?? { kind: 'internal' };

    await this.dependencies.waitForTurnRelease(options.threadId);
    const releaseTurn = this.dependencies.acquireTurn(options.threadId);
    if (!releaseTurn) throw new AgentThreadBusyError(options.threadId);

    try {
      if (fixedTarget) {
        await this.dependencies.startLifecycle(fixedTarget, options.content);
      }
    } catch (error) {
      releaseTurn();
      throw error;
    }

    let settled = false;
    const settle = async (
      terminal: 'done' | 'error',
      message?: string,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      try {
        if (fixedTarget) {
          if (terminal === 'error') {
            await this.dependencies.failLifecycle(
              fixedTarget,
              message ?? 'Internal Error',
            );
          } else {
            await this.dependencies.finishLifecycle(fixedTarget);
          }
        }
      } finally {
        releaseTurn();
      }
    };

    return {
      binding,
      fixedTarget,
      events: this.runInvocation(options, binding, fixedTarget, settle),
      dispose: (error) =>
        settle(
          error === undefined ? 'done' : 'error',
          error === undefined ? undefined : errorMessage(error),
        ),
    };
  }

  private async *runInvocation(
    options: AgentThreadInvocationOptions,
    binding: AgentBinding,
    fixedTarget: FixedAgentNodeTarget | null,
    settle: (terminal: 'done' | 'error', message?: string) => Promise<void>,
  ): AsyncGenerator<AgentStreamEvent, void> {
    let runError: unknown;
    let eventError: string | null = null;
    let sawDone = false;

    try {
      const stream = this.createDispatchStream(options, binding, fixedTarget);
      try {
        for await (const event of stream) {
          if (event.type === AGENT_SSE_EVENTS.Done) sawDone = true;
          if (event.type === AGENT_SSE_EVENTS.Error) {
            eventError = event.data.error || 'Internal Error';
          }
          yield event;
        }
      } catch (error) {
        runError = error;
      }

      const failed =
        !sawDone && !options.signal.aborted && (runError || eventError);
      await settle(
        failed ? 'error' : 'done',
        runError ? errorMessage(runError) : (eventError ?? undefined),
      );

      if (runError) throw runError;
    } finally {
      await settle('error', 'Invocation stream was not drained');
    }
  }

  private createDispatchStream(
    options: AgentThreadInvocationOptions,
    binding: AgentBinding,
    fixedTarget: FixedAgentNodeTarget | null,
  ): AsyncGenerator<AgentStreamEvent, unknown> {
    if (binding.kind === 'external') {
      return this.dependencies.runExternal({
        binding,
        threadId: options.threadId,
        canvasId: options.canvasId,
        envelope: options.envelope,
        overlay: emptyAcpOverlay(),
        ...(fixedTarget?.launchOverrides
          ? { launchOverrides: fixedTarget.launchOverrides }
          : {}),
        signal: options.signal,
        logger: options.logger,
        debugPrompt: options.debugPrompt,
      });
    }

    const skillDispatch = planSkillDispatch(options.envelope.skills.resolved);
    if (skillDispatch.closeLiveHandle) {
      this.dependencies.closeHandle(options.threadId);
    }
    const runsSkillAuthoring = skillDispatch.closeLiveHandle;
    return this.dependencies.runInternal({
      scope: options.mode,
      workloadType: skillDispatch.workloadType,
      modelRole: skillDispatch.modelRole,
      hasImage: runsSkillAuthoring
        ? envelopeHasImage(options.envelope)
        : undefined,
      threadId: options.threadId,
      canvasId: options.canvasId,
      envelope: options.envelope,
      context: {
        systemPrompt: buildAgentSystemPrompt({
          canvasId: options.canvasId,
          mode: options.mode,
        }),
        messages: [],
        tools: [],
      },
      modelId: options.modelId,
      reasoningEffort: options.reasoningEffort,
      maxIterations: 20,
      signal: options.signal,
      logger: options.logger,
      debugPrompt: options.debugPrompt,
    });
  }
}

export const agentThreadService = new AgentThreadService();
