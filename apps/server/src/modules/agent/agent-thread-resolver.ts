// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  agentBindingSchema,
  getQuestionNodeStatus,
  type AgentBinding,
  type AgentLaunchOverrides,
  type CanvasNodeId,
  type QuestionNodeStatus,
} from '@huabu/shared';

import {
  InvalidAgentLaunchOverridesError,
  parseAgentLaunchOverrides,
} from './agent-launch-overrides.js';
import { space } from '../storage/index.js';

interface StoredNode {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
}

interface ResolverDependencies {
  readCanvasNodes: (canvasId: string) => Promise<StoredNode[] | null>;
  readNodeContent: (canvasId: string, nodeId: string) => Promise<string | null>;
}

export interface FixedAgentNodeTarget {
  canvasId: string;
  nodeId: CanvasNodeId;
  threadId: string;
  agentBinding: AgentBinding;
  launchOverrides?: AgentLaunchOverrides;
  status: QuestionNodeStatus;
  content: string;
}

export type AgentThreadResolutionErrorCode =
  | 'canvas_not_found'
  | 'duplicate_thread'
  | 'invalid_binding'
  | 'invalid_launch_overrides'
  | 'missing_node_content';

export class AgentThreadResolutionError extends Error {
  constructor(
    public readonly code: AgentThreadResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentThreadResolutionError';
  }
}

const DEFAULT_DEPENDENCIES: ResolverDependencies = {
  readCanvasNodes: async (canvasId) => {
    const canvas = await space(canvasId).read();
    return canvas ? (canvas.state.nodes as StoredNode[]) : null;
  },
  readNodeContent: async (canvasId, nodeId) =>
    (await space(canvasId).nodes.read(nodeId))?.record.content ?? null,
};

/**
 * Resolve the current Canvas-backed fixed Agent Node for one thread.
 *
 * This intentionally stays thin: issue #60 replaces only its storage lookup
 * with the future Workspace-global thread index.
 */
export class AgentThreadResolver {
  constructor(
    private readonly dependencies: ResolverDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async resolveAgentNodeId(
    canvasId: string,
    threadId: string,
  ): Promise<CanvasNodeId | null> {
    const nodes = await this.dependencies.readCanvasNodes(canvasId);
    if (!nodes) {
      throw new AgentThreadResolutionError(
        'canvas_not_found',
        `Canvas ${canvasId} does not exist`,
      );
    }
    const matches = nodes.filter((node) => node.data?.threadId === threadId);
    if (matches.length > 1) {
      throw new AgentThreadResolutionError(
        'duplicate_thread',
        `Thread ${threadId} is bound to multiple Canvas nodes`,
      );
    }
    const node = matches[0];
    return node?.type === 'question' ? (node.id as CanvasNodeId) : null;
  }

  async resolveFixedAgentNode(
    canvasId: string,
    threadId: string,
  ): Promise<FixedAgentNodeTarget | null> {
    const nodes = await this.dependencies.readCanvasNodes(canvasId);
    if (!nodes) {
      throw new AgentThreadResolutionError(
        'canvas_not_found',
        `Canvas ${canvasId} does not exist`,
      );
    }

    const matches = nodes.filter((node) => node.data?.threadId === threadId);
    if (matches.length > 1) {
      throw new AgentThreadResolutionError(
        'duplicate_thread',
        `Thread ${threadId} is bound to multiple Canvas nodes`,
      );
    }

    const node = matches[0];
    if (
      !node ||
      node.type !== 'question' ||
      node.data?.agentBindingPolicy !== 'fixed'
    ) {
      return null;
    }

    const parsedBinding = agentBindingSchema.safeParse(node.data.agentBinding);
    if (!parsedBinding.success) {
      throw new AgentThreadResolutionError(
        'invalid_binding',
        `Fixed Agent Node ${node.id} has no valid external binding`,
      );
    }

    let launchOverrides: AgentLaunchOverrides | undefined;
    try {
      launchOverrides = parseAgentLaunchOverrides(
        node.data.agentLaunchOverrides,
      );
    } catch (error) {
      if (error instanceof InvalidAgentLaunchOverridesError) {
        throw new AgentThreadResolutionError(
          'invalid_launch_overrides',
          `Fixed Agent Node ${node.id}: ${error.message}`,
        );
      }
      throw error;
    }

    const content = await this.dependencies.readNodeContent(canvasId, node.id);
    if (content === null) {
      throw new AgentThreadResolutionError(
        'missing_node_content',
        `Fixed Agent Node ${node.id} has no content record`,
      );
    }

    return {
      canvasId,
      nodeId: node.id as CanvasNodeId,
      threadId,
      agentBinding: parsedBinding.data,
      ...(launchOverrides ? { launchOverrides } : {}),
      status: getQuestionNodeStatus(node.data),
      content,
    };
  }
}

export const agentThreadResolver = new AgentThreadResolver();
