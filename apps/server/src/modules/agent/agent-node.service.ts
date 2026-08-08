// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import path from 'node:path';

import { getAgentTeamRegistry } from '@agenetes/agentlet-host';

import {
  createId,
  readAgentIcon,
  type AgentLaunchOverrides,
  type CanvasCommand,
  type CanvasNodeId,
  type CustomData,
  type Point,
} from '@huabu/shared';

import { executeCanvasCommandsOnHost } from '../canvas/canvas-command-router.js';
import { getCanvasStore } from '../storage/index.js';

import type { ExecuteOnServerOutput } from '../canvas/canvas-executor.js';

const MAX_WORKING_DIR_PATH_LENGTH = 4096;
const MAX_ADDITIONAL_PREAMBLE_LENGTH = 16 * 1024;

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
  ) {
    super(message);
    this.name = 'AgentNodeCreationError';
  }
}

interface AgentProfileRecord {
  id: string;
  alias: string;
  customData?: CustomData;
}

interface AgentProfileRegistryPort {
  getProfile(profileId: string): AgentProfileRecord | null | undefined;
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
  getProfileRegistry: () => getAgentTeamRegistry(),
  readCanvasNodes: defaultReadCanvasNodes,
  execute: executeCanvasCommandsOnHost,
};

function isAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  );
}

function validatePosition(position: Point): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new AgentNodeCreationError(
      'invalid_position',
      'Agent Node position must contain finite coordinates',
    );
  }
}

function validateLaunchOverrides(
  overrides: AgentLaunchOverrides | undefined,
): void {
  if (!overrides) return;
  const { workingDirPath, additionalInitialPreamble } = overrides;
  if (
    workingDirPath !== undefined &&
    (workingDirPath.length === 0 ||
      workingDirPath.trim() !== workingDirPath ||
      workingDirPath.length > MAX_WORKING_DIR_PATH_LENGTH ||
      !isAbsolutePath(workingDirPath))
  ) {
    throw new AgentNodeCreationError(
      'invalid_launch_overrides',
      `workingDirPath must be an absolute path no longer than ${MAX_WORKING_DIR_PATH_LENGTH} characters`,
    );
  }
  if (
    additionalInitialPreamble !== undefined &&
    (additionalInitialPreamble.trim().length === 0 ||
      additionalInitialPreamble.length > MAX_ADDITIONAL_PREAMBLE_LENGTH)
  ) {
    throw new AgentNodeCreationError(
      'invalid_launch_overrides',
      `additionalInitialPreamble must be non-empty and no longer than ${MAX_ADDITIONAL_PREAMBLE_LENGTH} characters`,
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
    validateLaunchOverrides(input.launchOverrides);

    const nodes = this.dependencies.readCanvasNodes(input.canvasId);
    if (!nodes) {
      throw new AgentNodeCreationError(
        'canvas_not_found',
        `Canvas ${input.canvasId} does not exist`,
      );
    }
    const sourceNodeId = requireValidAnchor(nodes, input.anchor);

    const registry = this.dependencies.getProfileRegistry();
    if (!registry) {
      throw new AgentNodeCreationError(
        'profile_registry_unavailable',
        'Agent Profile registry is not ready',
      );
    }
    const selectableIds = new Set(registry.listSelectableProfileIds());
    const profile = registry.getProfile(input.profileId);
    if (!profile || !selectableIds.has(profile.id)) {
      throw new AgentNodeCreationError(
        'profile_not_selectable',
        `Agent Profile ${input.profileId} is not selectable`,
      );
    }

    const nodeId = createId('node') as CanvasNodeId;
    const threadId = createId('thread');
    const edgeId = createId('edge');
    const hasLaunchOverrides =
      input.launchOverrides?.workingDirPath !== undefined ||
      input.launchOverrides?.additionalInitialPreamble !== undefined;
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
                ...(hasLaunchOverrides
                  ? { agentLaunchOverrides: input.launchOverrides }
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
      );
    }

    return { canvasId: input.canvasId, nodeId, threadId };
  }
}

export const agentNodeService = new AgentNodeService();
