// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createId,
  readAgentIcon,
  type AgentLaunchOverrides,
  type CanvasCommand,
  type CanvasNodeId,
  type Point,
} from '@huabu/shared';

import {
  InvalidAgentLaunchOverridesError,
  parseAgentLaunchOverrides,
} from './agent-launch-overrides.js';
import {
  requireSelectableAgentProfile,
  SelectableAgentProfileError,
  type SelectableAgentProfile,
} from './selectable-agent-profile.js';
import { executeCanvasCommandsOnHost } from '../canvas/canvas-command-router.js';
import { getCanvasStore } from '../storage/index.js';

import type { ExecuteOnServerOutput } from '../canvas/canvas-executor.js';

type AgentNodeAnchor =
  | { kind: 'task-root'; taskNoteNodeId: CanvasNodeId }
  | { kind: 'delegated'; parentAgentNodeId: CanvasNodeId };

export interface CreateAgentNodeInput {
  canvasId: string;
  profileId: string;
  position: Point;
  anchor: AgentNodeAnchor;
  launchOverrides?: AgentLaunchOverrides;
}

export interface CreateAgentNodeResult {
  canvasId: string;
  nodeId: CanvasNodeId;
  threadId: string;
}

export type AgentNodeCreationErrorCode =
  | 'canvas_not_found'
  | 'profile_registry_unavailable'
  | 'profile_not_selectable'
  | 'anchor_not_found'
  | 'invalid_anchor'
  | 'invalid_position'
  | 'invalid_launch_overrides'
  | 'node_creation_failed'
  | 'lineage_edge_failed';

export class AgentNodeCreationError extends Error {
  constructor(
    public readonly code: AgentNodeCreationErrorCode,
    message: string,
    public readonly createdNodeId?: CanvasNodeId,
    public readonly createdThreadId?: string,
  ) {
    super(message);
    this.name = 'AgentNodeCreationError';
  }
}

interface AgentProfileRegistryPort {
  getProfile(profileId: string): SelectableAgentProfile | null | undefined;
  listSelectableProfileIds(): string[];
}

interface StoredNode {
  id: string;
  type?: string;
  data?: { threadId?: unknown };
}

interface AgentNodeServiceDependencies {
  getProfileRegistry: () => AgentProfileRegistryPort | null;
  readCanvasNodes: (canvasId: string) => StoredNode[] | null;
  execute: (input: {
    canvasId: string;
    commands: readonly CanvasCommand[];
    originator: { source: 'system' };
  }) => Promise<ExecuteOnServerOutput>;
}

function defaultReadCanvasNodes(canvasId: string): StoredNode[] | null {
  const canvas = getCanvasStore(canvasId).read();
  if (!canvas) return null;
  return canvas.state.nodes as StoredNode[];
}

const DEFAULT_DEPENDENCIES: AgentNodeServiceDependencies = {
  getProfileRegistry: () => null,
  readCanvasNodes: defaultReadCanvasNodes,
  execute: executeCanvasCommandsOnHost,
};

function validatePosition(position: Point): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new AgentNodeCreationError(
      'invalid_position',
      'Agent Node position must contain finite coordinates',
    );
  }
}

function anchorNodeId(anchor: AgentNodeAnchor): CanvasNodeId {
  return anchor.kind === 'task-root'
    ? anchor.taskNoteNodeId
    : anchor.parentAgentNodeId;
}

function requireValidAnchor(
  nodes: readonly StoredNode[],
  anchor: AgentNodeAnchor,
): CanvasNodeId {
  const nodeId = anchorNodeId(anchor);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new AgentNodeCreationError(
      'anchor_not_found',
      `Agent Node anchor ${nodeId} does not exist`,
    );
  }
  const expectedType = anchor.kind === 'task-root' ? 'note' : 'question';
  if (node.type !== expectedType) {
    throw new AgentNodeCreationError(
      'invalid_anchor',
      `${anchor.kind} Agent Node anchor must be a ${expectedType} node`,
    );
  }
  if (
    anchor.kind === 'delegated' &&
    (typeof node.data?.threadId !== 'string' || node.data.threadId.length === 0)
  ) {
    throw new AgentNodeCreationError(
      'invalid_anchor',
      'Delegated Agent Node anchor must own a thread',
    );
  }
  return nodeId;
}

export class AgentNodeService {
  constructor(
    private readonly dependencies: AgentNodeServiceDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async create(input: CreateAgentNodeInput): Promise<CreateAgentNodeResult> {
    validatePosition(input.position);
    let launchOverrides: AgentLaunchOverrides | undefined;
    try {
      launchOverrides = parseAgentLaunchOverrides(input.launchOverrides);
    } catch (error) {
      if (error instanceof InvalidAgentLaunchOverridesError) {
        throw new AgentNodeCreationError(
          'invalid_launch_overrides',
          error.message,
        );
      }
      throw error;
    }

    const nodes = this.dependencies.readCanvasNodes(input.canvasId);
    if (!nodes) {
      throw new AgentNodeCreationError(
        'canvas_not_found',
        `Canvas ${input.canvasId} does not exist`,
      );
    }
    const sourceNodeId = requireValidAnchor(nodes, input.anchor);

    let profile: SelectableAgentProfile;
    try {
      const registry = this.dependencies.getProfileRegistry();
      profile = registry
        ? requireSelectableAgentProfile(input.profileId, registry)
        : requireSelectableAgentProfile(input.profileId);
    } catch (error) {
      if (error instanceof SelectableAgentProfileError) {
        throw new AgentNodeCreationError(
          error.code === 'registry_unavailable'
            ? 'profile_registry_unavailable'
            : 'profile_not_selectable',
          error.message,
        );
      }
      throw error;
    }

    const nodeId = createId('node') as CanvasNodeId;
    const threadId = createId('thread');
    const edgeId = createId('edge');
    const output = await this.dependencies.execute({
      canvasId: input.canvasId,
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: nodeId,
              nodeType: 'question',
              position: input.position,
              data: {
                content: '',
                threadId,
                agentBinding: {
                  kind: 'external',
                  profileId: profile.id,
                  alias: profile.alias,
                },
                agentBindingPolicy: 'fixed',
                agentIcon: readAgentIcon(profile),
                ...(launchOverrides
                  ? { agentLaunchOverrides: launchOverrides }
                  : {}),
                origin: { type: 'ai-operate' },
              },
            },
          ],
        },
        {
          type: 'CONNECT_NODES',
          edges: [{ id: edgeId, source: sourceNodeId, target: nodeId }],
        },
      ],
      originator: { source: 'system' },
    });

    if (output.results[0]?.applied !== true) {
      throw new AgentNodeCreationError(
        'node_creation_failed',
        'Canvas rejected Agent Node creation',
      );
    }
    if (output.results[1]?.applied !== true) {
      throw new AgentNodeCreationError(
        'lineage_edge_failed',
        `Agent Node ${nodeId} was created but its lineage edge was rejected`,
        nodeId,
        threadId,
      );
    }

    return { canvasId: input.canvasId, nodeId, threadId };
  }
}

export const agentNodeService = new AgentNodeService();
