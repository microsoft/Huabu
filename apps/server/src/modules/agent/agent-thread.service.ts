// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import { emptyAcpOverlay } from '@agenetes/acp-driver';

import { AGENT_SSE_EVENTS, agentBindingSchema } from '@huabu/shared';

import { externalAgentRealization } from './acp/external-agent-realization.js';
import { runAcpAgent } from './acp/service.js';
import { agenetes, EXTERNAL_DRIVER_KIND } from './agenetes/drivers.js';
import { agentNodeBinding } from './agent-node-binding.js';
import { agentNodeLifecycle } from './agent-node-lifecycle.js';
import {
  agentThreadResolver,
  type AgentNodeTarget,
  type FixedAgentNodeTarget,
} from './agent-thread-resolver.js';
import { runAgent } from './agent.service.js';
import { envelopeHasImage } from './conversation/envelope.js';
import { readWorkspaceMemory } from './memory/index.js';
import { planSkillDispatch } from './skill-model-routing.js';
import { resolveSpacePrompt } from './space-instruction-frames.js';
import { acquireAgentTurn, waitForAgentTurnRelease } from './turn-lease.js';
import { loadAgent } from '../../prompt/index.js';
import { canvasAcpNamespace } from '../workspace/paths.js';

import type {
  RealizedExternalAgentThread,
  RealizeExternalAgentThreadOptions,
} from './acp/external-agent-realization.js';
import type { HuabuSubmission } from './agenetes/handle.js';
import type { ChatEnvelope } from './conversation/envelope.js';
import type { RenderedSpacePrompt } from './space-instruction-frames.js';
import type {
  AgentBinding,
  AgentMode,
  AgentStreamEvent,
  ReasoningEffort,
} from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

interface AgentThreadServiceDependencies {
  resolveAgentNode: (
    canvasId: string,
    threadId: string,
  ) => Promise<AgentNodeTarget | null>;
  resolveFixedAgentNode: (
    canvasId: string,
    threadId: string,
  ) => Promise<FixedAgentNodeTarget | null>;
  resolvePersistedExternalBinding: (
    canvasId: string,
    threadId: string,
  ) => Extract<AgentBinding, { kind: 'external' }> | null;
  resolvePersistedSpacePrompt: (
    canvasId: string,
    threadId: string,
  ) => {
    realised: boolean;
    markdown?: string;
    record?: ReturnType<typeof agenetes.record> | null;
  };
  collectSpacePrompt: (
    canvasId: string,
    targetAgentNodeId: string,
  ) => Promise<RenderedSpacePrompt | null>;
  realizeExternal: (
    options: RealizeExternalAgentThreadOptions,
  ) => Promise<RealizedExternalAgentThread>;
  waitForTurnRelease: typeof waitForAgentTurnRelease;
  acquireTurn: typeof acquireAgentTurn;
  startLifecycle: typeof agentNodeLifecycle.start;
  finishLifecycle: typeof agentNodeLifecycle.done;
  failLifecycle: typeof agentNodeLifecycle.error;
  runExternal: typeof runAcpAgent;
  runInternal: typeof runAgent;
  closeHandle: (threadId: string) => void;
  confirmBinding?: typeof agentNodeBinding.confirm;
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

export function spacePromptFromWorkloadSpec(spec: unknown): string | undefined {
  if (!spec || typeof spec !== 'object') return undefined;
  const value = spec as Record<string, unknown>;
  const hostContext = value.hostContext;
  if (hostContext && typeof hostContext === 'object') {
    const prompt = (hostContext as Record<string, unknown>).spacePrompt;
    if (typeof prompt === 'string') return prompt;
  }
  return undefined;
}

const DEFAULT_DEPENDENCIES: AgentThreadServiceDependencies = {
  resolveAgentNode: (canvasId, threadId) =>
    agentThreadResolver.resolveAgentNode(canvasId, threadId),
  resolveFixedAgentNode: (canvasId, threadId) =>
    agentThreadResolver.resolveFixedAgentNode(canvasId, threadId),
  resolvePersistedExternalBinding: (canvasId, threadId) => {
    const record = agenetes.record(canvasAcpNamespace(canvasId), threadId);
    if (!record || record.spec.kind !== EXTERNAL_DRIVER_KIND) return null;
    return externalBindingFromWorkloadSpec(record.spec.spec);
  },
  resolvePersistedSpacePrompt: (canvasId, threadId) => {
    const record = agenetes.record(canvasAcpNamespace(canvasId), threadId);
    if (!record) return { realised: false, record: null };
    const markdown = spacePromptFromWorkloadSpec(record.spec.spec);
    return markdown
      ? { realised: true, markdown, record }
      : { realised: true, record };
  },
  collectSpacePrompt: resolveSpacePrompt,
  realizeExternal: (options) => externalAgentRealization.realize(options),
  waitForTurnRelease: waitForAgentTurnRelease,
  acquireTurn: acquireAgentTurn,
  startLifecycle: (...args) => agentNodeLifecycle.start(...args),
  finishLifecycle: (...args) => agentNodeLifecycle.done(...args),
  failLifecycle: (...args) => agentNodeLifecycle.error(...args),
  runExternal: runAcpAgent,
  runInternal: runAgent,
  closeHandle: (threadId) => agenetes.close(threadId),
  confirmBinding: (...args) => agentNodeBinding.confirm(...args),
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
  /** Expensive context gathering runs after admission and cancellation tracking. */
  envelope: ChatEnvelope | (() => Promise<ChatEnvelope>);
  /** Canonical durable submission; ordinary chat callers omit it. */
  submission?: HuabuSubmission;
  requestBinding?: AgentBinding;
  agentTarget?: AgentNodeTarget | null;
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
  'signal' | 'envelope'
> & {
  signal: AbortSignal;
  envelope?: ChatEnvelope;
  spacePrompt?: string;
  externalRealization?: RealizedExternalAgentThread;
  onExecutionCreated?: () => Promise<void>;
};

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
  phase: 'preparing' | 'executing' | 'stopping' | 'settled';
  outcome?: 'done' | 'error';
  errorMessage?: string;
}

function buildAgentSystemPrompt(params: {
  canvasId: string | undefined;
  mode: Parameters<typeof loadAgent>[0];
  additionalInitialPreamble?: string;
  spacePrompt?: string;
}): string {
  const agentCfg = loadAgent(params.mode, { canvasId: params.canvasId });
  const workspaceMemory = readWorkspaceMemory();
  const base = workspaceMemory
    ? `${agentCfg.systemPrompt}\n\n<workspace_memory>\n${workspaceMemory}\n</workspace_memory>`
    : agentCfg.systemPrompt;
  return [base, params.spacePrompt, params.additionalInitialPreamble]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
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
    const target = await this.dependencies.resolveAgentNode(canvasId, threadId);
    if (target?.agentBinding?.kind === 'external') {
      return { binding: target.agentBinding, fixedTarget: null };
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
      phase: 'preparing',
    };
    this.activeInvocations.set(options.threadId, active);

    const onAbort = () => {
      if (active.phase !== 'settled' && !active.outcome)
        active.phase = 'stopping';
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const invocationToken = randomUUID();
    let agentTarget: AgentNodeTarget | null = null;
    let fixedTarget: FixedAgentNodeTarget | null = null;
    let binding: AgentBinding = options.requestBinding ?? { kind: 'internal' };
    let externalRealization: RealizedExternalAgentThread | undefined;
    let envelope =
      typeof options.envelope === 'function' ? undefined : options.envelope;
    let projected = false;
    let settled = false;
    const settle = async (
      terminal: 'done' | 'error',
      message?: string,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      terminal = active.outcome ?? terminal;
      message =
        active.outcome === 'error' ? (active.errorMessage ?? message) : message;
      active.phase = 'settled';
      resolveTurnStarted(false);
      try {
        if (projected && agentTarget) {
          if (terminal === 'error') {
            await this.dependencies.failLifecycle(
              agentTarget,
              message ?? 'Internal Error',
              invocationToken,
            );
          } else {
            await this.dependencies.finishLifecycle(
              agentTarget,
              invocationToken,
            );
          }
        }
      } catch (error) {
        options.logger.error(
          { err: error, threadId: options.threadId, outcome: terminal },
          'Agent Node terminal projection failed',
        );
        throw error;
      } finally {
        signal.removeEventListener('abort', onAbort);
        if (this.activeInvocations.get(options.threadId) === active) {
          this.activeInvocations.delete(options.threadId);
        }
        releaseTurn();
      }
    };
    let spacePrompt: string | undefined;
    let persistedSpacePrompt:
      | ReturnType<
          AgentThreadServiceDependencies['resolvePersistedSpacePrompt']
        >
      | undefined;
    try {
      // Resolve only after admission: a queued request must not execute an old draft.
      agentTarget = options.canvasId
        ? await this.dependencies.resolveAgentNode(
            options.canvasId,
            options.threadId,
          )
        : null;
      fixedTarget = await this.resolveFixedTarget(
        options.canvasId,
        options.threadId,
      );
      if (agentTarget) {
        binding =
          agentTarget.agentBinding ?? fixedTarget?.agentBinding ?? binding;
        agentNodeBinding.assertRequestedBinding(
          binding,
          options.requestBinding,
        );
        await this.dependencies.startLifecycle(
          agentTarget,
          options.content,
          invocationToken,
        );
        projected = true;
        if (binding.kind !== 'external') {
          persistedSpacePrompt = this.dependencies.resolvePersistedSpacePrompt(
            agentTarget.canvasId,
            agentTarget.threadId,
          );
          const canonical = await this.dependencies.confirmBinding?.(
            agentTarget,
            { record: persistedSpacePrompt.record },
          );
          if (canonical)
            agentNodeBinding.assertRequestedBinding(canonical, binding);
          binding = canonical ?? binding;
          agentNodeBinding.assertRequestedBinding(
            binding,
            options.requestBinding,
          );
        }
      } else if (options.canvasId) {
        binding =
          this.dependencies.resolvePersistedExternalBinding(
            options.canvasId,
            options.threadId,
          ) ?? binding;
      }
      if (!signal.aborted && typeof options.envelope === 'function') {
        envelope = await options.envelope();
      }
      if (signal.aborted) {
        await settle('done');
      } else if (binding.kind === 'external') {
        externalRealization = await this.dependencies.realizeExternal({
          threadId: options.threadId,
          canvasId: options.canvasId,
          requestedBinding: binding,
          agentTarget,
          fixedTarget,
          logger: options.logger,
          signal,
          turnLeaseHeld: true,
        });
        binding = externalRealization.binding;
      }
      if (
        !signal.aborted &&
        agentTarget &&
        options.canvasId &&
        binding.kind !== 'external'
      ) {
        const persisted =
          persistedSpacePrompt ??
          this.dependencies.resolvePersistedSpacePrompt(
            options.canvasId,
            options.threadId,
          );
        if (persisted.realised) {
          spacePrompt = persisted.markdown;
        } else {
          const collected = await this.dependencies.collectSpacePrompt(
            options.canvasId,
            agentTarget.nodeId,
          );
          spacePrompt = collected?.markdown;
          if (
            collected &&
            (collected.diagnostics.truncated ||
              collected.diagnostics.truncatedNoteIds.length > 0 ||
              collected.diagnostics.omittedUnsupportedIds.length > 0 ||
              collected.diagnostics.omittedEmptyTextIds.length > 0 ||
              collected.diagnostics.omittedMissingIds.length > 0)
          ) {
            options.logger.warn(
              {
                canvasId: options.canvasId,
                threadId: options.threadId,
                spacePromptDiagnostics: collected.diagnostics,
              },
              'Space Prompt collection completed with diagnostics',
            );
          }
        }
      }
    } catch (error) {
      const cancelled =
        signal.aborted &&
        (error === signal.reason ||
          (error instanceof Error && error.name === 'AbortError'));
      try {
        await settle(cancelled ? 'done' : 'error', errorMessage(error));
      } catch (projectionError) {
        options.logger.error(
          { err: projectionError, preparationError: error },
          'Preparation failed and its terminal projection also failed',
        );
        if (cancelled) throw projectionError;
      }
      if (!cancelled) throw error;
    }

    const effectiveOptions: EffectiveAgentThreadInvocationOptions = {
      ...options,
      agentTarget,
      envelope,
      signal,
      spacePrompt,
      externalRealization,
      mode: !agentTarget?.invocationToken
        ? (agentTarget?.agentMode ?? options.mode)
        : options.mode,
      onExecutionCreated: agentTarget
        ? async () => {
            await this.dependencies.confirmBinding?.(agentTarget, {
              required: true,
            });
          }
        : undefined,
    };

    return {
      binding,
      fixedTarget,
      signal,
      events: this.runInvocation(
        effectiveOptions,
        binding,
        fixedTarget,
        () => {
          if (!signal.aborted) active.phase = 'executing';
          resolveTurnStarted(true);
        },
        settle,
        active,
        () => settled,
      ),
      dispose: (error) =>
        settle(
          error === undefined ? 'done' : 'error',
          error === undefined ? undefined : errorMessage(error),
        ),
    };
  }

  stop(threadId: string): boolean {
    const active = this.activeInvocations.get(threadId);
    if (active?.outcome || active?.phase === 'settled') return false;
    const controller = active?.abortController;
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
    active: ActiveAgentInvocation,
    isSettled: () => boolean,
  ): AsyncGenerator<AgentStreamEvent, void> {
    let runError: unknown;
    let eventError: string | null = null;
    let sawDone = false;

    try {
      if (isSettled()) return;
      if (options.signal.aborted) {
        await settle('done');
        return;
      }
      const stream = this.createDispatchStream(
        options,
        binding,
        fixedTarget,
        onTurnStarted,
      );
      try {
        for await (const event of stream) {
          if (event.type === AGENT_SSE_EVENTS.Done) {
            sawDone = true;
            active.outcome = 'done';
          }
          if (event.type === AGENT_SSE_EVENTS.Error) {
            eventError = event.data.error || 'Internal Error';
            if (!sawDone && !options.signal.aborted) {
              active.outcome = 'error';
              active.errorMessage = eventError;
            }
          }
          yield event;
        }
      } catch (error) {
        runError = error;
        if (!sawDone && !options.signal.aborted && !active.outcome) {
          active.outcome = 'error';
          active.errorMessage = errorMessage(error);
        }
      }

      const failed =
        !sawDone &&
        (active.outcome === 'error' ||
          (!options.signal.aborted && (runError || eventError)));
      await settle(
        failed ? 'error' : 'done',
        runError ? errorMessage(runError) : (eventError ?? undefined),
      );

      if (runError) throw runError;
    } finally {
      await settle(
        options.signal.aborted ? 'done' : 'error',
        'Invocation stream was not drained',
      );
    }
  }

  private createDispatchStream(
    options: EffectiveAgentThreadInvocationOptions,
    binding: AgentBinding,
    fixedTarget: FixedAgentNodeTarget | null,
    onTurnStarted: () => void,
  ): AsyncGenerator<AgentStreamEvent, unknown> {
    if (!options.envelope) throw new Error('Invocation input was not prepared');
    if (binding.kind === 'external') {
      if (!options.externalRealization) {
        throw new Error(
          `External thread ${options.threadId} was not canonically realized`,
        );
      }
      return this.dependencies.runExternal({
        handle: options.externalRealization.handle,
        binding,
        threadId: options.threadId,
        canvasId: options.canvasId,
        envelope: options.envelope,
        submission: options.submission,
        overlay: emptyAcpOverlay(),
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
            options.agentTarget?.launchOverrides?.additionalInitialPreamble ??
            fixedTarget?.launchOverrides?.additionalInitialPreamble,
          spacePrompt: options.spacePrompt,
        }),
        messages: [],
        tools: [],
      },
      modelId: options.modelId,
      spacePrompt: options.spacePrompt,
      reasoningEffort: options.reasoningEffort,
      maxIterations: 20,
      signal: options.signal,
      logger: options.logger,
      debugPrompt: options.debugPrompt,
      onTurnStarted,
      onExecutionCreated: options.onExecutionCreated,
    });
  }
}

export const agentThreadService = new AgentThreadService();
