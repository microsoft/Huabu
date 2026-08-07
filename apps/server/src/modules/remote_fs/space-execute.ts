// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  agentCanvasCommandSchema,
  createId,
  type AgentOperationCommand,
  type RfsExecuteRequest,
  type RfsExecuteResponse,
} from '@huabu/shared';
import { nodeRevision, type Delta } from '@huabu/shared/canvas-engine';

import { prepareAgentCanvasCommands } from '../canvas/agent-command-preparation.js';
import { executeCanvasCommandsOnHost } from '../canvas/canvas-command-router.js';

import type { CanvasCommand } from '@huabu/shared';

function projectCommand(command: CanvasCommand): AgentOperationCommand {
  if (command.type === 'CREATE_NODES') {
    return agentCanvasCommandSchema.parse({
      ...command,
      nodes: command.nodes.map(({ id: _id, data, ...node }) => {
        if (!data) return node;
        const {
          origin: _origin,
          labelSource: _labelSource,
          ...agentData
        } = data;
        return { ...node, data: agentData };
      }),
    });
  }
  if (command.type === 'CONNECT_NODES') {
    return agentCanvasCommandSchema.parse({
      ...command,
      edges: command.edges.map(({ id: _id, style, ...edge }) => {
        if (!style) return edge;
        const { labelSource: _labelSource, ...agentStyle } = style;
        return { ...edge, style: agentStyle };
      }),
    });
  }
  if (command.type === 'MERGE_NODE_DATA') {
    return agentCanvasCommandSchema.parse({
      ...command,
      patches: command.patches.map(({ patch, ...entry }) => {
        const { labelSource: _labelSource, ...agentPatch } = patch;
        return { ...entry, patch: agentPatch };
      }),
    });
  }
  if (command.type === 'SET_EDGE_STYLE') {
    return agentCanvasCommandSchema.parse({
      ...command,
      edges: command.edges.map(({ style, ...entry }) => {
        const { labelSource: _labelSource, ...agentStyle } = style;
        return { ...entry, style: agentStyle };
      }),
    });
  }
  return agentCanvasCommandSchema.parse(command);
}

function collectDeltaIds(
  deltas: readonly Delta[],
  nodeIds: Set<string>,
  edgeIds: Set<string>,
  deletedNodeIds: Set<string>,
  deletedEdgeIds: Set<string>,
): void {
  for (const delta of deltas) {
    if (delta.type === 'INSERT_NODE') nodeIds.add(delta.node.id);
    else if (delta.type === 'REPLACE_NODE') nodeIds.add(delta.next.id);
    else if (delta.type === 'DELETE_NODE') {
      nodeIds.add(delta.node.id);
      deletedNodeIds.add(delta.node.id);
    } else if (delta.type === 'INSERT_EDGE') edgeIds.add(delta.edge.id);
    else if (delta.type === 'REPLACE_EDGE') edgeIds.add(delta.next.id);
    else if (delta.type === 'DELETE_EDGE') {
      edgeIds.add(delta.edge.id);
      deletedEdgeIds.add(delta.edge.id);
    }
  }
}

function collectCommandIds(
  command: CanvasCommand,
  nodeIds: Set<string>,
  edgeIds: Set<string>,
): void {
  switch (command.type) {
    case 'CREATE_NODES':
      for (const node of command.nodes) if (node.id) nodeIds.add(node.id);
      break;
    case 'DELETE_NODES':
    case 'REORDER_NODES':
    case 'ALIGN_NODES':
    case 'DISTRIBUTE_NODES':
      for (const nodeId of command.nodeIds) nodeIds.add(nodeId);
      break;
    case 'MERGE_NODE_DATA':
      for (const patch of command.patches) nodeIds.add(patch.nodeId);
      break;
    case 'SET_NODE_PARENT':
      for (const nodeId of command.nodeIds) nodeIds.add(nodeId);
      if (command.parentId) nodeIds.add(command.parentId);
      break;
    case 'DISSOLVE_FRAME':
    case 'SET_FRAME_LAYOUT':
      nodeIds.add(command.frameId);
      break;
    case 'SET_NODE_GEOMETRY':
      for (const item of command.items) nodeIds.add(item.nodeId);
      break;
    case 'CONNECT_NODES':
      for (const edge of command.edges) {
        nodeIds.add(edge.source);
        nodeIds.add(edge.target);
        if (edge.id) edgeIds.add(edge.id);
      }
      break;
    case 'DISCONNECT_EDGES':
      for (const edge of command.edges) {
        if (typeof edge === 'string') edgeIds.add(edge);
        else {
          nodeIds.add(edge.source);
          nodeIds.add(edge.target);
        }
      }
      break;
    case 'SET_EDGE_STYLE':
      for (const entry of command.edges) {
        if (typeof entry.edge === 'string') edgeIds.add(entry.edge);
        else {
          nodeIds.add(entry.edge.source);
          nodeIds.add(entry.edge.target);
        }
      }
      break;
    case 'SET_NODE_SELECTION':
    case 'SET_NODE_LOCKED':
    case 'CHANGE_NODE_TYPE':
      break;
    case 'SET_PORTAL_NODE_PINS':
      for (const update of command.updates) {
        for (const nodeId of update.sourceNodeIds) nodeIds.add(nodeId);
      }
      break;
  }
}

export async function executeRfsCommands(
  canvasId: string,
  request: RfsExecuteRequest,
  opts?: { hostThreadId?: string },
): Promise<RfsExecuteResponse> {
  const runId = request.runId ?? createId('run');
  const hostThreadId = opts?.hostThreadId;
  const output = await executeCanvasCommandsOnHost({
    canvasId,
    commands: prepareAgentCanvasCommands(request.commands, {
      allowCallerRevisions: true,
    }),
    // Authorship stays server-owned (`source: 'agent'`); the caller only
    // correlates which host conversation the write belongs to via the
    // `X-Huabu-Host-Thread-Id` header. When present, attribute the batch's
    // change-review records to that thread (persist to its sidecar +
    // broadcast) exactly like the built-in agent path.
    originator: {
      source: 'agent',
      ...(hostThreadId ? { threadId: hostThreadId } : {}),
    },
    runId,
    ...(hostThreadId ? { computeChanges: true } : {}),
  });

  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const deletedNodeIds = new Set<string>();
  const deletedEdgeIds = new Set<string>();
  collectDeltaIds(
    output.deltas,
    nodeIds,
    edgeIds,
    deletedNodeIds,
    deletedEdgeIds,
  );
  for (const result of output.results) {
    if (result.applied) collectCommandIds(result.command, nodeIds, edgeIds);
  }
  const commands = output.commands.map(projectCommand);
  const revisionByNodeId = new Map(
    output.pendingEffects.mutatedNodes.map((node) => [
      node.id,
      nodeRevision(node),
    ]),
  );

  return {
    canvasId: output.canvasId,
    runId,
    fromVersion: output.fromVersion,
    toVersion: output.toVersion,
    commands,
    results: output.results.map((result, index) => {
      const command = commands[index];
      if (!command) {
        throw new Error('Executor returned a result without a command');
      }
      return {
        index,
        type: command.type,
        applied: result.applied,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.nodes ? { nodes: result.nodes } : {}),
        ...(result.edges ? { edges: result.edges } : {}),
      };
    }),
    revisions: [...revisionByNodeId].map(([nodeId, rev]) => ({
      nodeId,
      rev,
    })),
    affected: {
      nodeIds: [...nodeIds],
      edgeIds: [...edgeIds],
      deletedNodeIds: [...deletedNodeIds],
      deletedEdgeIds: [...deletedEdgeIds],
    },
    ...(output.conflicts && output.conflicts.length > 0
      ? {
          conflicts: output.conflicts.map(
            ({ currentContent: _currentContent, ...conflict }) => conflict,
          ),
        }
      : {}),
  };
}
