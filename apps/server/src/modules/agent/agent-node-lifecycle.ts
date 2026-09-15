// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { agenetes } from './agenetes/drivers.js';
import { projectAgentNodeStateAlreadyLocked } from '../canvas/agent-node-projection.js';
import { space, withCanvasMutex } from '../storage/index.js';
import { canvasAcpNamespace } from '../workspace/paths.js';

import type { AgentNodeTarget } from './agent-thread-resolver.js';
import type { AgentNodeProjection as AgentNodeProjectionWrite } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

export interface AgentNodeProjection {
  threadId?: unknown;
  content?: unknown;
  status?: unknown;
  invocationToken?: unknown;
  bindingState?: unknown;
  [key: string]: unknown;
}

export type AgentNodeTransition = (
  current: AgentNodeProjection,
) => Record<string, unknown> | null;

interface LifecycleDependencies {
  transition: (
    target: AgentNodeTarget,
    update: AgentNodeTransition,
    alreadyLocked?: boolean,
  ) => Promise<void>;
  hasSubmission: (target: AgentNodeTarget) => boolean;
}

export class AgentNodeLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentNodeLifecycleError';
  }
}

async function transitionAgentNode(
  target: AgentNodeTarget,
  update: AgentNodeTransition,
  alreadyLocked = false,
): Promise<void> {
  const apply = async () => {
    const handle = space(target.canvasId);
    const canvas = await handle.read();
    const node = (canvas?.state.nodes as CanvasNode[] | undefined)?.find(
      (candidate) => candidate.id === target.nodeId,
    );
    if (
      !node ||
      node.type !== 'question' ||
      node.data?.threadId !== target.threadId
    ) {
      throw new AgentNodeLifecycleError(
        `Agent Node ${target.nodeId} no longer owns thread ${target.threadId}`,
      );
    }
    const content = await handle.nodes.read(target.nodeId);
    if (!content) {
      throw new AgentNodeLifecycleError(
        `Agent Node ${target.nodeId} has no content record`,
      );
    }
    const patch = update({ ...node.data, content: content.record.content });
    if (!patch) return;
    const { content: initialContent, ...metadata } = patch;
    const applied = await projectAgentNodeStateAlreadyLocked(
      target.canvasId,
      target.nodeId,
      {
        threadId: target.threadId,
        ...(typeof node.data.invocationToken === 'string'
          ? { expectedInvocationToken: node.data.invocationToken }
          : {}),
        ...metadata,
        ...(typeof initialContent === 'string' ? { initialContent } : {}),
      } as AgentNodeProjectionWrite,
    );
    if (!applied) {
      throw new AgentNodeLifecycleError(
        `Agent Node ${target.nodeId} lifecycle update was rejected`,
      );
    }
  };
  return alreadyLocked ? apply() : withCanvasMutex(target.canvasId, apply);
}

const DEFAULT_DEPENDENCIES: LifecycleDependencies = {
  transition: transitionAgentNode,
  hasSubmission: (target) =>
    agenetes.history(canvasAcpNamespace(target.canvasId), target.threadId, {
      withTail: true,
    }).turns.length > 0,
};

/** Projects decisions only; admission and binding remain owned by their coordinators. */
export class AgentNodeLifecycle {
  constructor(
    private readonly dependencies: LifecycleDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  start(
    target: AgentNodeTarget,
    prompt: string,
    invocationToken: string,
  ): Promise<void> {
    return this.dependencies.transition(target, (current) => ({
      ...(!current.invocationToken &&
      typeof current.content === 'string' &&
      current.content.trim().length === 0 &&
      !this.dependencies.hasSubmission(target)
        ? { content: prompt }
        : {}),
      invocationToken,
      status: 'running',
      errorMessage: '',
    }));
  }

  done(target: AgentNodeTarget, invocationToken: string): Promise<void> {
    return this.terminal(target, invocationToken, 'done', '');
  }

  error(
    target: AgentNodeTarget,
    message: string,
    invocationToken: string,
  ): Promise<void> {
    return this.terminal(target, invocationToken, 'error', message);
  }

  bind(target: AgentNodeTarget, alreadyLocked = false): Promise<void> {
    return this.dependencies.transition(
      target,
      (current) =>
        current.bindingState === 'bound' ? null : { bindingState: 'bound' },
      alreadyLocked,
    );
  }

  acknowledge(target: AgentNodeTarget, invocationToken: string): Promise<void> {
    return this.dependencies.transition(target, (current) =>
      current.invocationToken === invocationToken &&
      (current.status === 'done' || current.status === 'error')
        ? { viewed: true }
        : null,
    );
  }

  private terminal(
    target: AgentNodeTarget,
    invocationToken: string,
    status: 'done' | 'error',
    errorMessage: string,
  ): Promise<void> {
    return this.dependencies.transition(target, (current) =>
      current.invocationToken === invocationToken
        ? { status, errorMessage, viewed: false }
        : null,
    );
  }
}

export const agentNodeLifecycle = new AgentNodeLifecycle();
