// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  AcpServiceError,
  ensureAcpSession,
  resolveAcpAgentletId,
} from '@agenetes/acp-driver';

import { canvasAcpNamespace } from '../../workspace/paths.js';
import {
  acpRuntimePolicy,
  agenetes,
  EXTERNAL_DRIVER_KIND,
  type AcpHandle,
  type AcpWorkloadSpec,
} from '../agenetes/drivers.js';
import {
  agentNodeBinding,
  AgentNodeBindingError,
} from '../agent-node-binding.js';
import {
  agentThreadResolver,
  type AgentNodeTarget,
  type FixedAgentNodeTarget,
} from '../agent-thread-resolver.js';
import { conversationTitleService } from '../conversation-title.service.js';
import { resolveSpacePrompt } from '../space-instruction-frames.js';
import { acquireAgentTurn } from '../turn-lease.js';
import { ensureProfileCacheSubscription } from './profile-cache-port.js';
import { getExternalAgentRuntimeConfig } from './runtime-config.js';
import { buildAcpWorkloadSpec } from './service.js';

import type { AcpSessionEntry } from '@agenetes/acp-driver';
import type { Namespace } from '@agenetes/protocol';
import type { AgentBinding } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

type ExternalBinding = Extract<AgentBinding, { kind: 'external' }>;

export type ExternalAgentRealizationErrorCode =
  | 'external_binding_required'
  | 'external_binding_conflict'
  | 'external_working_directory_conflict'
  | 'external_thread_kind_conflict';

export class ExternalAgentRealizationError extends Error {
  constructor(
    public readonly code: ExternalAgentRealizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExternalAgentRealizationError';
  }
}

export interface RealizeExternalAgentThreadOptions {
  threadId: string;
  canvasId?: string;
  requestedBinding?: ExternalBinding;
  requestedCwd?: string;
  agentTarget?: AgentNodeTarget | null;
  fixedTarget?: FixedAgentNodeTarget | null;
  logger: FastifyBaseLogger;
  signal?: AbortSignal;
  /** The prompt coordinator already owns admission across preparation. */
  turnLeaseHeld?: boolean;
}

export interface RealizedExternalAgentThread {
  binding: ExternalBinding;
  fixedTarget: FixedAgentNodeTarget | null;
  spec: AcpWorkloadSpec;
  handle: AcpHandle;
  agentTarget?: AgentNodeTarget | null;
}

interface RealizationDependencies {
  resolveAgentNode: (
    canvasId: string,
    threadId: string,
  ) => Promise<AgentNodeTarget | null>;
  resolveFixedAgentNode: (
    canvasId: string,
    threadId: string,
  ) => Promise<FixedAgentNodeTarget | null>;
  collectSpacePrompt: typeof resolveSpacePrompt;
  readRecord: (
    namespace: Namespace,
    threadId: string,
  ) => ReturnType<typeof agenetes.record>;
  createHandle: (spec: AcpWorkloadSpec) => AcpHandle;
  buildSpec: typeof buildAcpWorkloadSpec;
  subscribeProfileCache: typeof ensureProfileCacheSubscription;
  subscribeTitles?: (canvasId: string, threadId: string) => void;
  ensureSession: (
    realized: RealizedExternalAgentThread,
    logger: FastifyBaseLogger,
  ) => Promise<AcpSessionEntry>;
  confirmBinding?: typeof agentNodeBinding.confirm;
  acquireTurn?: typeof acquireAgentTurn;
}

function bindingFromSpec(spec: AcpWorkloadSpec): ExternalBinding {
  return {
    kind: 'external',
    alias: spec.spec.binding.alias,
    profileId: spec.spec.binding.profileId,
  };
}

async function ensureSessionFromCanonicalSpec(
  realized: RealizedExternalAgentThread,
  logger: FastifyBaseLogger,
): Promise<AcpSessionEntry> {
  const { spec } = realized;
  const resolvedEnvironment =
    await acpRuntimePolicy.resolveRuntimeEnvironment?.(spec.spec);
  const env =
    resolvedEnvironment || spec.spec.env
      ? { ...resolvedEnvironment, ...spec.spec.env }
      : undefined;
  const record = agenetes.record(spec.namespace, spec.threadId);
  return ensureAcpSession({
    agentletId: resolveAcpAgentletId(spec),
    threadId: spec.threadId,
    binding: spec.spec.binding,
    namespace: spec.namespace,
    ...(spec.spec.cwd !== undefined && { cwd: spec.spec.cwd }),
    ...(spec.spec.recipe !== undefined && { recipe: spec.spec.recipe }),
    ...(env !== undefined && { env }),
    ...(record?.state !== undefined && {
      priorState: record.state as Parameters<
        typeof ensureAcpSession
      >[0]['priorState'],
    }),
    ...(spec.spec.initialPreferences !== undefined && {
      initialPreferences: spec.spec.initialPreferences,
    }),
    idleTimeoutSecs: getExternalAgentRuntimeConfig().idleTimeoutSecs,
    logger,
  });
}

const DEFAULT_DEPENDENCIES: RealizationDependencies = {
  resolveAgentNode: (canvasId, threadId) =>
    agentThreadResolver.resolveAgentNode(canvasId, threadId),
  resolveFixedAgentNode: (canvasId, threadId) =>
    agentThreadResolver.resolveFixedAgentNode(canvasId, threadId),
  collectSpacePrompt: resolveSpacePrompt,
  readRecord: (namespace, threadId) => agenetes.record(namespace, threadId),
  createHandle: (spec) => agenetes.create(spec) as AcpHandle,
  buildSpec: buildAcpWorkloadSpec,
  subscribeProfileCache: ensureProfileCacheSubscription,
  subscribeTitles: (canvasId, threadId) =>
    conversationTitleService.subscribe(canvasId, threadId),
  ensureSession: ensureSessionFromCanonicalSpec,
  confirmBinding: (...args) => agentNodeBinding.confirm(...args),
  acquireTurn: acquireAgentTurn,
};

export class ExternalAgentRealizationService {
  private readonly inFlight = new Map<
    string,
    Promise<RealizedExternalAgentThread>
  >();

  constructor(
    private readonly dependencies: RealizationDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async realize(
    options: RealizeExternalAgentThreadOptions,
  ): Promise<RealizedExternalAgentThread> {
    const namespace = canvasAcpNamespace(options.canvasId ?? '');
    const key = `${namespace.name}\u0000${namespace.storage?.root ?? ''}\u0000${options.threadId}`;
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.realizeOnce(options, namespace);
      this.inFlight.set(key, pending);
    }
    try {
      const realized = await pending;
      this.validateRequest(realized, options);
      return realized;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  ensureSession(
    realized: RealizedExternalAgentThread,
    logger: FastifyBaseLogger,
  ): Promise<AcpSessionEntry> {
    return this.dependencies.ensureSession(realized, logger);
  }

  private async realizeOnce(
    options: RealizeExternalAgentThreadOptions,
    namespace: Namespace,
  ): Promise<RealizedExternalAgentThread> {
    const record = this.dependencies.readRecord(namespace, options.threadId);
    const release =
      !record && !options.turnLeaseHeld && this.dependencies.acquireTurn
        ? this.dependencies.acquireTurn(options.threadId)
        : undefined;
    if (release === null) {
      throw new AgentNodeBindingError(
        'agent_draft_busy',
        `Thread ${options.threadId} is preparing or running`,
      );
    }
    try {
      return await this.realizeAdmitted(options, namespace, record);
    } finally {
      release?.();
    }
  }

  private async realizeAdmitted(
    options: RealizeExternalAgentThreadOptions,
    namespace: Namespace,
    record: ReturnType<typeof agenetes.record>,
  ): Promise<RealizedExternalAgentThread> {
    const fixedTarget =
      options.fixedTarget === undefined
        ? options.canvasId
          ? await this.dependencies.resolveFixedAgentNode(
              options.canvasId,
              options.threadId,
            )
          : null
        : options.fixedTarget;
    const agentTarget =
      options.agentTarget === undefined
        ? (fixedTarget ??
          (options.canvasId
            ? await this.dependencies.resolveAgentNode(
                options.canvasId,
                options.threadId,
              )
            : null))
        : options.agentTarget;
    if (agentTarget)
      await this.dependencies.confirmBinding?.(agentTarget, {
        record: record ?? null,
      });

    if (record) {
      if (record.spec.kind !== EXTERNAL_DRIVER_KIND) {
        throw new ExternalAgentRealizationError(
          'external_thread_kind_conflict',
          `Thread ${options.threadId} is already realized with a non-external agent`,
        );
      }
      const spec = record.spec as AcpWorkloadSpec;
      const binding = bindingFromSpec(spec);
      const realized = {
        binding,
        fixedTarget,
        agentTarget,
        spec,
        handle: this.dependencies.createHandle(spec),
      };
      this.dependencies.subscribeProfileCache(
        options.threadId,
        binding.profileId,
      );
      this.dependencies.subscribeTitles?.(
        options.canvasId ?? '',
        options.threadId,
      );
      return realized;
    }

    const binding =
      agentTarget?.agentBinding ??
      fixedTarget?.agentBinding ??
      options.requestedBinding;
    if (!binding || binding.kind !== 'external') {
      throw new ExternalAgentRealizationError(
        'external_binding_required',
        `Thread ${options.threadId} has no external Agent binding`,
      );
    }

    if (
      agentTarget &&
      options.requestedBinding &&
      options.requestedBinding.profileId !== binding.profileId
    ) {
      throw new ExternalAgentRealizationError(
        'external_binding_conflict',
        `Thread ${options.threadId} is configured for Profile ${binding.profileId}`,
      );
    }

    options.signal?.throwIfAborted();
    const collected = agentTarget
      ? await this.dependencies.collectSpacePrompt(
          agentTarget.canvasId,
          agentTarget.nodeId,
        )
      : null;
    options.signal?.throwIfAborted();
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
          canvasId: agentTarget?.canvasId,
          threadId: options.threadId,
          spacePromptDiagnostics: collected.diagnostics,
        },
        'Space Prompt collection completed with diagnostics',
      );
    }

    const spec = this.dependencies.buildSpec({
      binding,
      threadId: options.threadId,
      canvasId: options.canvasId,
      cwd: agentTarget ? undefined : options.requestedCwd,
      ...((agentTarget?.launchOverrides ?? fixedTarget?.launchOverrides)
        ? {
            launchOverrides:
              agentTarget?.launchOverrides ?? fixedTarget?.launchOverrides,
          }
        : {}),
      spacePrompt: collected?.markdown,
    });
    if (
      agentTarget &&
      options.requestedCwd !== undefined &&
      options.requestedCwd !== spec.spec.cwd
    ) {
      throw new ExternalAgentRealizationError(
        'external_working_directory_conflict',
        `Thread ${options.threadId} is fixed to working directory ${spec.spec.cwd ?? '(profile default)'}`,
      );
    }

    const realized = {
      binding,
      fixedTarget,
      agentTarget,
      spec,
      handle: this.dependencies.createHandle(spec),
    };
    if (agentTarget)
      await this.dependencies.confirmBinding?.(agentTarget, { required: true });
    this.dependencies.subscribeProfileCache(
      options.threadId,
      binding.profileId,
    );
    this.dependencies.subscribeTitles?.(
      options.canvasId ?? '',
      options.threadId,
    );
    return realized;
  }

  private validateRequest(
    realized: RealizedExternalAgentThread,
    options: RealizeExternalAgentThreadOptions,
  ): void {
    const fixedBinding =
      realized.agentTarget?.agentBinding ?? realized.fixedTarget?.agentBinding;
    if (
      fixedBinding &&
      (fixedBinding.kind !== 'external' ||
        fixedBinding.profileId !== realized.binding.profileId)
    ) {
      throw new ExternalAgentRealizationError(
        'external_binding_conflict',
        `Fixed Agent Node for thread ${options.threadId} does not match its realized Profile`,
      );
    }
    const fixedCwd = (
      realized.agentTarget?.launchOverrides ??
      realized.fixedTarget?.launchOverrides
    )?.workingDirPath;
    if (fixedCwd !== undefined && fixedCwd !== realized.spec.spec.cwd) {
      throw new ExternalAgentRealizationError(
        'external_working_directory_conflict',
        `Fixed Agent Node for thread ${options.threadId} does not match its realized working directory`,
      );
    }
    if (
      options.requestedBinding &&
      options.requestedBinding.profileId !== realized.binding.profileId
    ) {
      throw new ExternalAgentRealizationError(
        'external_binding_conflict',
        `Thread ${options.threadId} is realized with Profile ${realized.binding.profileId}`,
      );
    }
    if (
      options.requestedCwd !== undefined &&
      options.requestedCwd !== realized.spec.spec.cwd
    ) {
      throw new ExternalAgentRealizationError(
        'external_working_directory_conflict',
        `Thread ${options.threadId} is realized with working directory ${realized.spec.spec.cwd ?? '(profile default)'}`,
      );
    }
  }
}

export function realizationHttpError(error: unknown): {
  status: 409 | 503;
  body: { message: string; code: string };
} {
  if (error instanceof ExternalAgentRealizationError) {
    return {
      status: 409,
      body: { message: error.message, code: error.code },
    };
  }
  if (error instanceof AgentNodeBindingError) {
    return { status: 409, body: { message: error.message, code: error.code } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 503,
    body: {
      message,
      code: error instanceof AcpServiceError ? error.code : 'internal',
    },
  };
}

export const externalAgentRealization = new ExternalAgentRealizationService();
