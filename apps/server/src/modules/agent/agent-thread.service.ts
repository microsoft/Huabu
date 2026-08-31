// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { emptyAcpOverlay } from '@agenetes/acp-driver';

import { AGENT_SSE_EVENTS, agentBindingSchema } from '@huabu/shared';

import { runAcpAgent } from './acp/service.js';
import { agenetes, EXTERNAL_DRIVER_KIND } from './agenetes/drivers.js';
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
import { canvasAcpNamespace } from '../workspace/paths.js';

import type { HuabuSubmission } from './agenetes/handle.js';
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
  ) => Promise<FixedAgentNodeTarget | null>;
  resolvePersistedExternalBinding: (
    canvasId: string,
    threadId: string,
  ) => Extract<AgentBinding, { kind: 'external' }> | null;
  waitForTurnRelease: typeof waitForAgentTurnRelease;
  acquireTurn: typeof acquireAgentTurn;
  startLifecycle: typeof agentNodeLifecycle.start;
  finishLifecycle: typeof agentNodeLifecycle.done;
  failLifecycle: typeof agentNodeLifecycle.error;
  runExternal: typeof runAcpAgent;
  runInternal: typeof runAgent;
  closeHandle: (threadId: string) => void;
}

export function externalBindingFromWorkloadSpec(
  spec: unknown,
): Extract<AgentBinding, { kind: 'external' }> | null {
  if (!spec || typeof spec !== 'object') return null;
  const binding = (spec as { binding?: unknown }).binding;
  if (!binding || typeof binding !== 'object') return null;
  const parsed = agentBindingSchema.safeParse({
    ...(binding as Record<string, unknown>),
    kind: 'external',
  });
  return parsed.success && parsed.data.kind === 'external' ? parsed.data : null;
}

const DEFAULT_DEPENDENCIES: AgentThreadServiceDependencies = {
  resolveFixedAgentNode: (canvasId, threadId) =>
    agentThreadResolver.resolveFixedAgentNode(canvasId, threadId),
  resolvePersistedExternalBinding: (canvasId, threadId) => {
    const record = agenetes.record(canvasAcpNamespace(canvasId), threadId);
    if (!record || record.spec.kind !== EXTERNAL_DRIVER_KIND) return null;
    return externalBindingFromWorkloadSpec(record.spec.spec);
  },
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
  /** Canonical durable submission; ordinary chat callers omit it. */
  submission?: HuabuSubmission;
  requestBinding?: AgentBinding;
  fixedTarget?: FixedAgentNodeTarget | null;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  logger: FastifyBaseLogger;
  debugPrompt?: {
    turnNumber: number;
    threadId: string;
    mode: string;
    logger: FastifyBaseLogger;
  };
}

type EffectiveAgentThreadInvocationOptions = Omit<
  AgentThreadInvocationOptions,
  'signal'
> & { signal: AbortSignal };

export interface AgentThreadInvocation {
  binding: AgentBinding;
  fixedTarget: FixedAgentNodeTarget | null;
  signal: AbortSignal;
  events: AsyncGenerator<AgentStreamEvent, void>;
  dispose: (error?: unknown) => Promise<void>;
}

export interface ExternalAgentThreadTarget {
  binding: Extract<AgentBinding, { kind: 'external' }>;
  fixedTarget: FixedAgentNodeTarget | null;
}

interface ActiveAgentInvocation {
  canvasId?: string;
  abortController: AbortController;
  turnStarted: Promise<boolean>;
  resolveTurnStarted: (started: boolean) => void;
}

function buildAgentSystemPrompt(params: {
  canvasId: string | undefined;
  mode: Parameters<typeof loadAgent>[0];
  additionalInitialPreamble?: string;
}): string {
  const agentCfg = loadAgent(params.mode, { canvasId: params.canvasId });
  const workspaceMemory = readWorkspaceMemory();
  const base = workspaceMemory
    ? `${agentCfg.systemPrompt}\n\n<workspace_memory>\n${workspaceMemory}\n</workspace_memory>`
    : agentCfg.systemPrompt;
  return params.additionalInitialPreamble
    ? `${base}\n\n${params.additionalInitialPreamble}`
    : base;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Internal Error';
}

export class AgentThreadService {
  private readonly activeInvocations = new Map<string, ActiveAgentInvocation>();

  constructor(
    private readonly dependencies: AgentThreadServiceDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async resolveFixedTarget(
    canvasId: string | undefined,
    threadId: string,
  ): Promise<FixedAgentNodeTarget | null> {
    return canvasId
      ? this.dependencies.resolveFixedAgentNode(canvasId, threadId)
      : null;
  }

  async resolveExternalTarget(
    canvasId: string,
    threadId: string,
  ): Promise<ExternalAgentThreadTarget | null> {
    const fixedTarget = await this.resolveFixedTarget(canvasId, threadId);
    if (fixedTarget) {
      return fixedTarget.agentBinding.kind === 'external'
        ? { binding: fixedTarget.agentBinding, fixedTarget }
        : null;
    }
    const binding = this.dependencies.resolvePersistedExternalBinding(
      canvasId,
      threadId,
    );
    return binding ? { binding, fixedTarget: null } : null;
  }

  invokeSubmission(
    options: AgentThreadInvocationOptions & { submission: HuabuSubmission },
  ): Promise<AgentThreadInvocation> {
    return this.invoke(options);
  }

  async invoke(
    options: AgentThreadInvocationOptions,
  ): Promise<AgentThreadInvocation> {
    const fixedTarget =
      options.fixedTarget === undefined
        ? await this.resolveFixedTarget(options.canvasId, options.threadId)
        : options.fixedTarget;
    const binding: AgentBinding = fixedTarget?.agentBinding ??
      options.requestBinding ?? { kind: 'internal' };

    await this.dependencies.waitForTurnRelease(options.threadId);
    const releaseTurn = this.dependencies.acquireTurn(options.threadId);
    if (!releaseTurn) throw new AgentThreadBusyError(options.threadId);

    const abortController = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, abortController.signal])
      : abortController.signal;
    let resolveTurnStarted!: (started: boolean) => void;
    const turnStarted = new Promise<boolean>((resolve) => {
      resolveTurnStarted = resolve;
    });
    const active: ActiveAgentInvocation = {
      canvasId: options.canvasId,
      abortController,
      turnStarted,
      resolveTurnStarted,
    };
    this.activeInvocations.set(options.threadId, active);

    try {
      if (fixedTarget) {
        await this.dependencies.startLifecycle(fixedTarget, options.content);
      }
    } catch (error) {
      resolveTurnStarted(false);
      if (this.activeInvocations.get(options.threadId) === active) {
        this.activeInvocations.delete(options.threadId);
      }
      releaseTurn();
      throw error;
    }

    const effectiveOptions: EffectiveAgentThreadInvocationOptions = {
      ...options,
      signal,
    };

    let settled = false;
    const settle = async (
      terminal: 'done' | 'error',
      message?: string,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      resolveTurnStarted(false);
      if (this.activeInvocations.get(options.threadId) === active) {
        this.activeInvocations.delete(options.threadId);
      }
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
      signal,
      events: this.runInvocation(
        effectiveOptions,
        binding,
        fixedTarget,
        () => resolveTurnStarted(true),
        settle,
      ),
      dispose: (error) =>
        settle(
          error === undefined ? 'done' : 'error',
          error === undefined ? undefined : errorMessage(error),
        ),
    };
  }

  stop(threadId: string): boolean {
    const controller = this.activeInvocations.get(threadId)?.abortController;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  isActive(threadId: string, canvasId?: string): boolean {
    const active = this.activeInvocations.get(threadId);
    if (!active) return false;
    return active.canvasId === canvasId;
  }

  async waitForTurnStart(
    threadId: string,
    canvasId?: string,
  ): Promise<boolean> {
    const active = this.activeInvocations.get(threadId);
    if (!active || (canvasId !== undefined && active.canvasId !== canvasId)) {
      return false;
    }
    return active.turnStarted;
  }

  private async *runInvocation(
    options: EffectiveAgentThreadInvocationOptions,
    binding: AgentBinding,
    fixedTarget: FixedAgentNodeTarget | null,
    onTurnStarted: () => void,
    settle: (terminal: 'done' | 'error', message?: string) => Promise<void>,
  ): AsyncGenerator<AgentStreamEvent, void> {
    let runError: unknown;
    let eventError: string | null = null;
    let sawDone = false;

    try {
      const stream = this.createDispatchStream(
        options,
        binding,
        fixedTarget,
        onTurnStarted,
      );
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
    options: EffectiveAgentThreadInvocationOptions,
    binding: AgentBinding,
    fixedTarget: FixedAgentNodeTarget | null,
    onTurnStarted: () => void,
  ): AsyncGenerator<AgentStreamEvent, unknown> {
    if (binding.kind === 'external') {
      return this.dependencies.runExternal({
        binding,
        threadId: options.threadId,
        canvasId: options.canvasId,
        envelope: options.envelope,
        submission: options.submission,
        overlay: emptyAcpOverlay(),
        ...(fixedTarget?.launchOverrides
          ? { launchOverrides: fixedTarget.launchOverrides }
          : {}),
        signal: options.signal,
        logger: options.logger,
        debugPrompt: options.debugPrompt,
        onTurnStarted,
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
      submission: options.submission,
      context: {
        systemPrompt: buildAgentSystemPrompt({
          canvasId: options.canvasId,
          mode: options.mode,
          additionalInitialPreamble:
            fixedTarget?.launchOverrides?.additionalInitialPreamble,
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
      onTurnStarted,
    });
  }
}

export const agentThreadService = new AgentThreadService();
