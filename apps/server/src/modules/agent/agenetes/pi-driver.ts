// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Huabu adapter for the standard `@agenetes/pi-driver`.
 *
 * This module keeps Huabu-specific policy at L1: compile the loaded
 * AGENT.md profile into a serializable `PiWorkloadSpec`, and resolve the
 * driver ports back into the host's current model/account/tool settings.
 *
 * It is intentionally not wired into the route yet: the first cutover
 * phase is Job-first equivalence, and this adapter lets that migration
 * happen without leaking host singletons into the subtree package.
 */

import { MODEL_ROLES } from '@huabu/shared';

import { materializeHuabuHistory } from './history-replay.js';
import {
  ensureApiKeyForRole,
  resolveModelByIdAsync,
  resolveModelForRoleAsync,
} from '../llm.js';
import { getSessionReadSet } from '../session-read-set.js';
import { buildAgentToolsByNames } from '../tools/index.js';

import type {
  PiDriverPorts,
  PiModelContext,
  PiModelRef,
  PiToolContext,
  PiToolRef,
  PiWorkloadSpec,
} from '@agenetes/pi-driver';
import type { Namespace, WorkloadType } from '@agenetes/protocol';
import type { ToolExecutionMode } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import type { ModelRole, NodeOrigin } from '@huabu/shared';

interface HuabuPiHostContext {
  readonly canvasId?: string;
  readonly origin?: NodeOrigin;
  readonly modelRole?: ModelRole;
  readonly hasImage?: boolean;
}

interface BuildHuabuPiWorkloadSpecOptions {
  readonly kind: string;
  readonly workloadType: WorkloadType;
  readonly namespace: Namespace;
  readonly threadId: string;
  readonly systemPrompt?: string;
  readonly toolNames: readonly string[];
  readonly initialMessages?: readonly Message[];
  readonly maxIterations?: number;
  readonly toolExecution?: ToolExecutionMode;
  readonly canvasId?: string;
  readonly origin?: NodeOrigin;
  readonly modelRole?: ModelRole;
  readonly hasImage?: boolean;
}

function getHuabuHostContext(
  ctx: PiModelContext | PiToolContext,
): HuabuPiHostContext {
  const raw = ctx.hostContext;
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  return {
    canvasId:
      typeof obj.canvasId === 'string' && obj.canvasId.length > 0
        ? obj.canvasId
        : undefined,
    origin:
      obj.origin && typeof obj.origin === 'object'
        ? (obj.origin as NodeOrigin)
        : undefined,
    modelRole:
      typeof obj.modelRole === 'string' && obj.modelRole in MODEL_ROLES
        ? (obj.modelRole as ModelRole)
        : undefined,
    hasImage: typeof obj.hasImage === 'boolean' ? obj.hasImage : undefined,
  };
}

function assertHostModelRef(ref: PiModelRef): void {
  if (ref.type !== 'host') {
    throw new Error(
      `[pi-driver] Unsupported Huabu PiModelRef ${JSON.stringify(ref)}. Only { type: 'host' } refs are supported.`,
    );
  }
}

export const huabuPiDriverPorts = {
  async resolveModel(ref, ctx) {
    assertHostModelRef(ref);
    const host = getHuabuHostContext(ctx);
    // A concrete per-thread model override (any id other than the symbolic
    // 'active') resolves within the active provider; 'active' falls back to
    // the role's host-policy model.
    if (ref.id !== 'active') {
      return resolveModelByIdAsync(ref.id);
    }
    return resolveModelForRoleAsync(host.modelRole ?? 'chat', {
      hasImage: host.hasImage,
    });
  },
  async getApiKey(ref, ctx) {
    assertHostModelRef(ref);
    const host = getHuabuHostContext(ctx);
    // The per-thread override stays within the active provider, so the chat
    // role's provider credential applies to both 'active' and a concrete id.
    return ensureApiKeyForRole(host.modelRole ?? 'chat', {
      hasImage: host.hasImage,
    });
  },
  async resolveTools(refs, ctx) {
    const unsupported = refs.filter(
      (ref) => ref.options && Object.keys(ref.options).length > 0,
    );
    if (unsupported.length > 0) {
      throw new Error(
        `[pi-driver] Tool ref options are not supported in the Huabu first milestone: ${unsupported
          .map((ref) => ref.name)
          .join(', ')}`,
      );
    }
    const host = getHuabuHostContext(ctx);
    return buildAgentToolsByNames(
      refs.map((ref) => ref.name),
      {
        canvasId: host.canvasId,
        origin: host.origin,
        threadId: ctx.threadId,
        readSet: getSessionReadSet(ctx.threadId),
      },
    );
  },
  async materializeHistory(input, ctx) {
    const host = getHuabuHostContext(ctx);
    return materializeHuabuHistory(input, {
      canvasId: host.canvasId ?? null,
    });
  },
} satisfies PiDriverPorts;

export function buildHuabuPiWorkloadSpec(
  options: BuildHuabuPiWorkloadSpecOptions,
): PiWorkloadSpec {
  const toolRefs: PiToolRef[] = options.toolNames.map((name) => ({ name }));

  return {
    kind: options.kind,
    workloadType: options.workloadType,
    namespace: options.namespace,
    threadId: options.threadId,
    spec: {
      ...(options.systemPrompt
        ? { initialPreamble: [options.systemPrompt] }
        : {}),
      recipe: {
        model: { type: 'host', id: 'active' },
        tools: toolRefs,
        runtime: {
          maxIterations: options.maxIterations,
          toolExecution: options.toolExecution,
        },
      },
      initialMessages: options.initialMessages,
      hostContext: {
        ...(options.canvasId ? { canvasId: options.canvasId } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.modelRole ? { modelRole: options.modelRole } : {}),
        ...(options.hasImage !== undefined
          ? { hasImage: options.hasImage }
          : {}),
      },
    },
  };
}
