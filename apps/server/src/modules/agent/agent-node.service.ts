// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createId,
  getDefaultAgentIcon,
  HUABU_AGENT_PROFILE_ID,
  readAgentIcon,
  type AgentBinding,
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
import { getLogger } from '../../utils/logger.js';
import { executeCanvasCommandsOnHost } from '../canvas/canvas-command-router.js';
import { buildSpatialBundle } from '../canvas/canvas-spatial.js';
import { space } from '../storage/index.js';

import type { ExecuteOnServerOutput } from '../canvas/canvas-executor.js';

const logger = getLogger('agent-node-service');

type AgentNodeAnchor =
  | { kind: 'task-root'; taskNoteNodeId: CanvasNodeId }
  | { kind: 'delegated'; parentAgentNodeId: CanvasNodeId };

export interface CreateAgentNodeInput {
  canvasId: string;
  profileId?: string;
  position: Point;
  anchor?: AgentNodeAnchor;
  launchOverrides?: AgentLaunchOverrides;
}

export interface CreateAgentNodeResult {
  canvasId: string;
  nodeId: CanvasNodeId;
  threadId: string;
  profileId: string;
  parentConnection: 'not_requested' | 'connected' | 'failed';
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
  readCanvasNodes: (canvasId: string) => Promise<StoredNode[] | null>;
  execute: (input: {
    canvasId: string;
    commands: readonly CanvasCommand[];
    originator: { source: 'system' };
  }) => Promise<ExecuteOnServerOutput>;
}

async function defaultReadCanvasNodes(
  canvasId: string,
): Promise<StoredNode[] | null> {
  const canvas = await space(canvasId).read();
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

function resolveAnchor(
  nodes: readonly StoredNode[],
  anchor: AgentNodeAnchor | undefined,
): CanvasNodeId | undefined {
  if (!anchor) return undefined;
  const nodeId = anchorNodeId(anchor);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    if (anchor.kind === 'delegated') return undefined;
    throw new AgentNodeCreationError(
      'anchor_not_found',
      `Agent Node anchor ${nodeId} does not exist`,
    );
  }
  const expectedType = anchor.kind === 'task-root' ? 'note' : 'question';
  if (node.type !== expectedType) {
    if (anchor.kind === 'delegated') return undefined;
    throw new AgentNodeCreationError(
      'invalid_anchor',
      `${anchor.kind} Agent Node anchor must be a ${expectedType} node`,
    );
  }
  if (
    anchor.kind === 'delegated' &&
    (typeof node.data?.threadId !== 'string' || node.data.threadId.length === 0)
  ) {
    return undefined;
  }
  return nodeId;
}

export async function resolveAgentNodePosition(
  canvasId: string,
  parentNodeId?: CanvasNodeId,
): Promise<Point> {
  const canvas = await space(canvasId).read();
  if (!canvas) {
    throw new AgentNodeCreationError(
      'canvas_not_found',
      `Canvas ${canvasId} does not exist`,
    );
  }
  const bundle = buildSpatialBundle(canvas);
  if (parentNodeId) {
    const parent = bundle.spatialById.get(parentNodeId);
    if (parent) {
      return {
        x: parent.rect.x + parent.rect.width + 120,
        y: parent.rect.y,
      };
    }
  }
  let right = -120;
  for (const node of bundle.spatialById.values()) {
    right = Math.max(right, node.rect.x + node.rect.width);
  }
  return { x: right + 120, y: 0 };
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

    const nodes = await this.dependencies.readCanvasNodes(input.canvasId);
    if (!nodes) {
      throw new AgentNodeCreationError(
        'canvas_not_found',
        `Canvas ${input.canvasId} does not exist`,
      );
    }
    const sourceNodeId = resolveAnchor(nodes, input.anchor);

    const profileId = input.profileId ?? HUABU_AGENT_PROFILE_ID;
    let binding: AgentBinding;
    let agentIcon;
    if (profileId === HUABU_AGENT_PROFILE_ID) {
      if (launchOverrides?.workingDirPath) {
        throw new AgentNodeCreationError(
          'invalid_launch_overrides',
          'workingDirPath is not supported by the Huabu Agent Profile',
        );
      }
      binding = { kind: 'internal' };
      agentIcon = getDefaultAgentIcon(profileId);
    } else {
      let profile: SelectableAgentProfile;
      try {
        const registry = this.dependencies.getProfileRegistry();
        profile = registry
          ? requireSelectableAgentProfile(profileId, registry)
          : requireSelectableAgentProfile(profileId);
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
      binding = {
        kind: 'external',
        profileId: profile.id,
        alias: profile.alias,
      };
      agentIcon = readAgentIcon(profile);
    }

    const nodeId = createId('node') as CanvasNodeId;
    const threadId = createId('thread');
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
                agentBinding: binding,
                agentBindingPolicy: 'fixed',
                agentIcon,
                ...(launchOverrides
                  ? { agentLaunchOverrides: launchOverrides }
                  : {}),
                origin: { type: 'ai-operate' },
              },
            },
          ],
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
    let parentConnection: CreateAgentNodeResult['parentConnection'] =
      input.anchor ? 'failed' : 'not_requested';
    if (sourceNodeId) {
      try {
        const edgeOutput = await this.dependencies.execute({
          canvasId: input.canvasId,
          commands: [
            {
              type: 'CONNECT_NODES',
              edges: [
                {
                  id: createId('edge'),
                  source: sourceNodeId,
                  target: nodeId,
                },
              ],
            },
          ],
          originator: { source: 'system' },
        });
        if (edgeOutput.results[0]?.applied === true) {
          parentConnection = 'connected';
        } else if (input.anchor?.kind === 'task-root') {
          throw new AgentNodeCreationError(
            'lineage_edge_failed',
            `Agent Node ${nodeId} was created but its Task lineage edge was rejected`,
            nodeId,
            threadId,
          );
        }
      } catch (error) {
        if (input.anchor?.kind === 'task-root') {
          if (error instanceof AgentNodeCreationError) throw error;
          throw new AgentNodeCreationError(
            'lineage_edge_failed',
            `Agent Node ${nodeId} was created but its Task lineage edge failed`,
            nodeId,
            threadId,
          );
        }
        logger.warn(
          { error, canvasId: input.canvasId, sourceNodeId, nodeId },
          'Agent parent connection failed after node creation',
        );
      }
    }

    return {
      canvasId: input.canvasId,
      nodeId,
      threadId,
      profileId,
      parentConnection,
    };
  }
}

export const agentNodeService = new AgentNodeService();
