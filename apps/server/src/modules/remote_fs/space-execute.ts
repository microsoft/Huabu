// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  agentCanvasCommandSchema,
  createId,
  type AgentOperationCommand,
  type RfsExecuteRequest,
  type RfsExecuteResponse,
} from '@huabu/shared';
import {
  collectCommandIds,
  nodeRevision,
  type Delta,
} from '@huabu/shared/canvas-engine';

import { prepareAgentCanvasCommands } from '../canvas/agent-command-preparation.js';
import {
  executeOnServer,
  type ExecuteOnServerOutput,
} from '../canvas/canvas-executor.js';
import { space } from '../storage/index.js';
import { normalizeSaveKey, type SaveKey } from '../storage/ports/save.js';

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

export interface ExecuteRfsOptions {
  hostThreadId?: string;
  /**
   * The authenticated caller. Required for `request.operationId` to take
   * effect: the stored response is kept per (principal, request id).
   */
  principalId?: string;
}

export async function executeRfsCommands(
  canvasId: string,
  request: RfsExecuteRequest,
  opts?: ExecuteRfsOptions,
): Promise<RfsExecuteResponse> {
  // Only a label. With a request id the executor stores the label it ran
  // under, so a replay reports the original run rather than this one.
  const runId = request.runId ?? createId('run');
  const hostThreadId = opts?.hostThreadId;
  if (request.operationId !== undefined && !opts?.principalId) {
    throw new Error('A request id needs an authenticated principal');
  }
  const output = await executeOnServer({
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
    ...(request.operationId !== undefined && opts?.principalId
      ? {
          request: {
            operationId: request.operationId,
            principalId: opts.principalId,
          },
        }
      : {}),
    ...(request.basis !== undefined ? { basis: request.basis } : {}),
    issueBasis: true,
  });
  return projectRfsExecuteResponse(output, runId);
}

/**
 * The stored response of an earlier request, exactly as a repeat of that
 * request would be answered, or null when nothing is stored under the id.
 */
export async function lookupRfsExecuteResponse(
  canvasId: string,
  key: SaveKey,
): Promise<RfsExecuteResponse | null> {
  const stored = await space(canvasId).save.lookup(normalizeSaveKey(key));
  if (!stored) return null;
  const output = stored.response as ExecuteOnServerOutput;
  if (typeof output.runId !== 'string') return null;
  return projectRfsExecuteResponse({ ...output, replayed: true }, output.runId);
}

/**
 * Project an executor output onto the agent-facing response.
 *
 * Pure over `output`, so a stored output projects to the same response the
 * original call returned.
 */
function projectRfsExecuteResponse(
  output: ExecuteOnServerOutput,
  fallbackRunId: string,
): RfsExecuteResponse {
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
    runId: output.runId ?? fallbackRunId,
    ...(output.operationId ? { operationId: output.operationId } : {}),
    ...(output.basis ? { basis: output.basis } : {}),
    ...(output.replayed ? { replayed: true as const } : {}),
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
