// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unified Agent Service
 *
 * Drives the built-in agent loop through the standard
 * `@agenetes/pi-driver`. The underlying pi-agent-core `Agent` owns the
 * transcript, executes tools, and emits lifecycle events; this module is
 * the Huabu composition layer that compiles the serializable workload
 * spec, renders the durable canonical submission, and bridges yielded
 * events into the `AsyncGenerator<StreamEvent>` shape every consumer
 * (chat / operate SSE route, sketch pipeline) consumes.
 *
 * Public surface:
 *  - {@link runAgent} — yields SSE-shaped events. Callers that need
 *    structured output (e.g. sketch) drain the generator
 *    themselves and pull the relevant `tool_result` payload.
 */

import {
  agenetes,
  INTERNAL_DRIVER_KIND,
  type BuiltinHandle,
  type BuiltinWorkloadSpec,
} from './agenetes/drivers.js';
import { createChatSubmission } from './agenetes/handle.js';
import { buildHuabuPiWorkloadSpec } from './agenetes/pi-driver.js';
import { loadAgent, type AgentId } from '../../prompt/index.js';
import { canvasAcpNamespace } from '../workspace/paths.js';
import { renderInternalAgentInputs } from './conversation/prompt/build-prompt.js';
import { dumpAssembledPrompt } from './conversation/prompt/debug-prompt.js';
import { type ToolScope } from './tools/index.js';

import type { HuabuSubmission } from './agenetes/handle.js';
import type { ChatEnvelope } from './conversation/envelope.js';
import type { WorkloadType } from '@agenetes/protocol';
import type { Context, Message } from '@earendil-works/pi-ai';
import type { AgentStreamEvent, ModelRole, NodeOrigin } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

/**
 * SSE events yielded by `runAgent`.
 *
 * `runAgent` only emits the in-stream variants — `meta` and `end` are
 * synthesized by the route handler that owns the HTTP connection.
 */
export type StreamEvent = Exclude<AgentStreamEvent, { type: 'meta' | 'end' }>;

const appliedDeploymentSystemPrompts = new WeakMap<BuiltinHandle, string>();

/**
 * Keep a live Deployment's system prompt aligned with host-rendered context
 * without sending an identical control message before every turn.
 */
export async function syncDeploymentSystemPrompt(
  handle: BuiltinHandle,
  systemPrompt: string,
  initialSpecIsCurrent: boolean,
): Promise<void> {
  const appliedSystemPrompt = appliedDeploymentSystemPrompts.get(handle);
  if (appliedSystemPrompt === systemPrompt) return;

  if (!initialSpecIsCurrent || appliedSystemPrompt !== undefined) {
    const ack = await handle.control({
      type: 'set_context',
      data: { systemPrompt },
    });
    if (!ack.ok) {
      throw new Error(
        `[runAgent] Failed to push Deployment system prompt via set_context: ${ack.error}`,
      );
    }
  }
  appliedDeploymentSystemPrompts.set(handle, systemPrompt);
}

interface AgentLogger {
  info: (message: string) => void;
}

export interface AgentRunOptions {
  /**
   * Tool surface the agent runs against. Drives both the available
   * tool set and (via {@link buildToolsForScope}) any scope-specific
   * tool wiring.
   */
  scope: ToolScope;
  /**
   * Stable conversation identity. A Deployment uses it to reuse or recover
   * its live handle; Jobs use it only as canvas-write provenance.
   */
  threadId?: string;
  /** Current canvas ID available as implicit context for canvas-aware tools. */
  canvasId?: string;
  /**
   * This turn's structured input. When provided (the chat route), it is
   * rendered into the per-turn user message internally — symmetric with
   * the external/ACP path, which takes the same envelope — and the
   * rendered message is kept OUT of `context.messages` so the envelope
   * stays the single source of truth on reload.
   *
   * Optional for the internal, envelope-less callers (memory analyzer,
   * reachback operate) that assemble
   * `context.messages` directly: with no envelope, `runAgent` runs over
   * `context.messages` as-is and syncs the full final transcript back
   * (the legacy behaviour).
   */
  envelope?: ChatEnvelope;
  /** Pre-rendered durable submission for non-chat host events. */
  submission?: HuabuSubmission;
  /**
   * pi-ai Context for this run. The system prompt is host-rendered current
   * context; messages seed fresh handles and envelope-less Jobs. Durable
   * Deployment recovery is supplied by Agenetes instead. Treated as
   * read-only input: output leaves only through the generator return value.
   */
  context: Context;
  /**
   * `NodeOrigin` stamp forwarded to `canvas_commands` (and ignored by
   * other tools). Defaults inside the handler to `{ type: 'ai-operate' }`.
   */
  origin?: NodeOrigin;
  /** Model role used to resolve the Chat or Utility tier for this workload. */
  modelRole?: ModelRole;
  /** Whether this workload may send image content to the selected model. */
  hasImage?: boolean;
  /**
   * Per-thread model override id carried with this turn (built-in chat).
   * Applied to the thread before the run, so a model picked before the
   * first message is seeded on thread creation. Deployment-only.
   */
  modelId?: string;
  /**
   * Per-thread reasoning effort carried with this turn (built-in chat).
   * A pi thinking level, or `off` for the model default. Applied like
   * {@link AgentRunOptions.modelId}.
   */
  reasoningEffort?: string;
  /**
   * Soft cap on agent turns (LLM call + tool batch). When reached, the
   * agent loop is aborted internally and a cap-out error is emitted.
   * Mirrors the previous self-rolled `maxIterations`.
   */
  maxIterations?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /**
   * Lifecycle axis for the underlying driver.
   *
   * Main chat can now use a long-lived Deployment handle; envelope-less
   * internal callers (memory/sketch/reachback) stay Job-shaped.
   */
  workloadType?: WorkloadType;
  /** Structured logger for request-scoped diagnostics */
  logger?: AgentLogger;
  /**
   * Optional developer aid: when present (and `HUABU_DEBUG_PROMPT` is
   * set), dump the fully-assembled prompt for this turn. Lives here
   * rather than in the route because the route no longer holds the
   * rendered messages — they are built inside {@link runAgent}.
   */
  debugPrompt?: {
    turnNumber: number;
    threadId: string;
    mode: string;
    logger: FastifyBaseLogger;
  };
  /** Called after Agenetes has synchronously persisted this turn's start. */
  onTurnStarted?: () => void;
}

// ==================== Agent Loop ====================

/**
 * Run the built-in agent for one turn, streaming events as an async
 * generator.
 *
 * This is now a thin COMPOSITION shell over the mounted Agenetes instance:
 * it owns per-turn host policy, canonical rendering, and prompt debugging, then
 * hands a serializable {@link BuiltinWorkloadSpec} to
 * `agenetes.create(spec)` and drives one `run(...)`. The execution logic
 * now lives inside the standard `@agenetes/pi-driver`; this module keeps
 * only the Huabu adapter layer (profile -> tool refs/runtime + opaque host
 * context) and patches the standard tool-call stream back into the host's
 * `internalToolName` extension for existing UI consumers.
 *
 * `context.messages` is treated as read-only input; this run's output
 * delta leaves solely via the generator's return value.
 */
export async function* runAgent(
  options: AgentRunOptions,
): AsyncGenerator<StreamEvent, Message[], unknown> {
  const {
    scope,
    threadId,
    canvasId,
    envelope,
    submission: suppliedSubmission,
    context,
    origin,
    modelRole,
    hasImage,
    modelId,
    reasoningEffort,
    maxIterations,
    signal,
    workloadType = 'Job',
    logger,
    debugPrompt,
    onTurnStarted,
  } = options;

  const rendered = envelope
    ? await renderInternalAgentInputs(envelope, {
        canvasId: canvasId ?? null,
      })
    : undefined;
  const submission =
    suppliedSubmission ??
    (envelope ? createChatSubmission(envelope, rendered) : null);

  // Optional developer aid: dump the fully-assembled prompt (system +
  // prior history + this turn). No-op unless HUABU_DEBUG_PROMPT is set.
  // Lives in the composition layer so the built-in driver need not import
  // the host's prompt-debug utility; the handle calls it after lowering.
  const onRendered = debugPrompt
    ? (renderedMessages: Message[]) => {
        dumpAssembledPrompt({
          systemPrompt: context.systemPrompt ?? '',
          messages: [...context.messages, ...renderedMessages],
          newMessageCount: renderedMessages.length,
          turnNumber: debugPrompt.turnNumber,
          threadId: debugPrompt.threadId,
          canvasId: canvasId ?? null,
          mode: debugPrompt.mode,
          logger: debugPrompt.logger,
        });
      }
    : undefined;

  const agentCfg = loadAgent(scope as AgentId);

  // Bake this turn's built-in WorkloadSpec (I9.6). The Huabu adapter
  // compiles the loaded profile into tool refs + runtime knobs while the
  // standard pi-driver owns harness execution and durable-history recovery.
  //
  // Envelope-less / stateless callers (memory / reachback) have no
  // conversation thread. `threadId: ''` keeps the instance record key inert
  // and makes the factory resolve an ephemeral read-set + leave canvas
  // writes unattributed (every downstream consumer truthy-guards the thread
  // id), reproducing the pre-instance behaviour where these callers omitted
  // `threadId` entirely.
  const namespace = canvasAcpNamespace(canvasId ?? '');
  const deploymentThreadId = threadId ?? '';
  const liveHandle =
    workloadType === 'Deployment'
      ? agenetes.get(deploymentThreadId)
      : undefined;
  const durableRecord =
    workloadType === 'Deployment'
      ? agenetes.record(namespace, deploymentThreadId)
      : undefined;
  const spec: BuiltinWorkloadSpec = buildHuabuPiWorkloadSpec({
    kind: INTERNAL_DRIVER_KIND,
    workloadType,
    threadId: deploymentThreadId,
    namespace,
    systemPrompt: context.systemPrompt,
    toolNames: agentCfg.toolNames,
    initialMessages: context.messages,
    maxIterations: maxIterations ?? agentCfg.runtime.maxIterations,
    toolExecution: agentCfg.runtime.toolExecution,
    canvasId,
    origin,
    modelRole,
    hasImage,
  });

  // Static DriverMap construction guarantees that `internal` is the
  // pi-backed handle. Deployments get-or-create by `threadId`; Jobs mint a
  // fresh handle.
  const handle = agenetes.create(spec) as BuiltinHandle;

  // Apply any per-thread capability selection carried with this turn — a
  // model / reasoning effort the client picked (e.g. before the thread's
  // first message, when the settings endpoints have no record to target).
  // Deployment-only, and only when it differs from the persisted selection
  // so we don't rewrite the durable record every turn.
  if (workloadType === 'Deployment' && deploymentThreadId) {
    const priorSelection = (durableRecord?.state?.driverState ?? {}) as {
      modelId?: unknown;
      reasoningEffort?: unknown;
    };
    if (modelId && modelId !== priorSelection.modelId) {
      await handle.control({ type: 'set_model', data: { modelId } });
    }
    if (reasoningEffort && reasoningEffort !== priorSelection.reasoningEffort) {
      await handle.control({
        type: 'set_config_option',
        data: { optionId: 'reasoning_effort', value: reasoningEffort },
      });
    }
  }
  if (workloadType === 'Deployment' && context.systemPrompt !== undefined) {
    await syncDeploymentSystemPrompt(
      handle,
      context.systemPrompt,
      liveHandle === undefined && durableRecord === undefined,
    );
  }
  const iterator = handle.run(submission, {
    maxIterations: maxIterations ?? agentCfg.runtime.maxIterations,
    signal,
    logger,
    onRendered,
  });
  onTurnStarted?.();

  while (true) {
    const next = await iterator.next();
    if (next.done) return next.value;
    const event = next.value;
    if (event.type === 'tool_call') {
      yield {
        ...event,
        data: {
          ...event.data,
          internalToolName:
            event.data.title && event.data.title.length > 0
              ? event.data.title
              : undefined,
        },
      };
      continue;
    }
    yield event;
  }
}
