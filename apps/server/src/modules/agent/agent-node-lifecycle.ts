// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { executeCanvasCommandsOnHost } from '../canvas/canvas-command-router.js';

import type { FixedAgentNodeTarget } from './agent-thread-resolver.js';
import type { CanvasCommand } from '@huabu/shared';

interface LifecycleDependencies {
  execute: typeof executeCanvasCommandsOnHost;
}

const DEFAULT_DEPENDENCIES: LifecycleDependencies = {
  execute: executeCanvasCommandsOnHost,
};

const patchChains = new Map<string, Promise<void>>();

export class AgentNodeLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentNodeLifecycleError';
  }
}

export class AgentNodeLifecycle {
  constructor(
    private readonly dependencies: LifecycleDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  start(target: FixedAgentNodeTarget, prompt: string): Promise<void> {
    const firstTurn =
      target.status === 'idle' && target.content.trim().length === 0;
    return this.patch(target, {
      ...(firstTurn ? { content: prompt } : {}),
      status: 'running',
      errorMessage: '',
    });
  }

  done(target: FixedAgentNodeTarget): Promise<void> {
    return this.patch(target, { status: 'done', errorMessage: '' });
  }

  error(target: FixedAgentNodeTarget, message: string): Promise<void> {
    return this.patch(target, { status: 'error', errorMessage: message });
  }

  private patch(
    target: FixedAgentNodeTarget,
    data: Record<string, unknown>,
  ): Promise<void> {
    const key = `${target.canvasId}\0${target.nodeId}`;
    const previous = patchChains.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const command: CanvasCommand = {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: target.nodeId, patch: data }],
        };
        const output = await this.dependencies.execute({
          canvasId: target.canvasId,
          commands: [command],
          originator: { source: 'system' },
        });
        if (output.results[0]?.applied !== true) {
          throw new AgentNodeLifecycleError(
            `Agent Node ${target.nodeId} lifecycle update was rejected`,
          );
        }
      });
    patchChains.set(key, current);
    return current.finally(() => {
      if (patchChains.get(key) === current) patchChains.delete(key);
    });
  }
}

export const agentNodeLifecycle = new AgentNodeLifecycle();
