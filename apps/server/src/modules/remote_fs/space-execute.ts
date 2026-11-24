// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  AGENT_CANVAS_COMMAND_TYPES,
  agentCanvasCommandSchema,
  createId,
  type AgentOperationCommand,
  type RfsExecuteEditsRequest,
  type RfsExecuteRequest,
  type RfsExecuteResponse,
} from '@huabu/shared';

import { prepareAgentCanvasCommands } from '../canvas/agent-command-preparation.js';
import {
  executeOnServer,
  type ExecuteOnServerOutput,
} from '../canvas/canvas-executor.js';
import {
  outcomeOf,
  readStoredOutcome,
  replayedOutput,
} from '../canvas/execute-outcome.js';
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

export interface ExecuteRfsOptions {
  /** Thread to attribute Review records to; the caller has verified it. */
  hostThreadId?: string;
  /** The thread id as the caller sent it, verified or not. */
  claimedThreadId?: string;
  /**
   * The authenticated caller. Required for `request.operationId` to take
   * effect: the stored response is kept per (principal, request id).
   */
  principalId?: string;
}

/**
 * Execute an Agent's request.
 *
 * `{ commands, basis? }` is the form Agents are told about. It is run as
 * one edit per command, each quoting `basis`: a command that fails is
 * skipped and the others still apply (the conversion is the executor's,
 * `preparedEditsOf`). `{ edits }` states the edits itself; there an edit
 * takes effect as a whole or not at all.
 */
export async function executeRfsCommands(
  canvasId: string,
  request: RfsExecuteRequest | RfsExecuteEditsRequest,
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
    ...('edits' in request
      ? {
          edits: request.edits.map((edit) => ({
            ...(edit.basis !== undefined ? { basis: edit.basis } : {}),
            ...(edit.after?.length ? { after: edit.after } : {}),
            commands: prepareAgentCanvasCommands(edit.commands, {
              allowCallerRevisions: true,
            }),
          })),
        }
      : {
          commands: prepareAgentCanvasCommands(request.commands, {
            allowCallerRevisions: true,
          }),
          ...(request.basis !== undefined ? { basis: request.basis } : {}),
        }),
    // Authorship stays server-owned (`source: 'agent'`); the caller only
    // correlates which host conversation the write belongs to via the
    // `X-Huabu-Host-Thread-Id` header. When the route found that thread in
    // this Space, attribute the batch's change-review records to it (stored
    // in the same commit + broadcast) exactly like the built-in agent path.
    originator: {
      source: 'agent',
      ...(hostThreadId ? { threadId: hostThreadId } : {}),
    },
    runId,
    agentCovers: true,
    ...(hostThreadId ? { computeChanges: true } : {}),
    ...(opts?.claimedThreadId ? { claimedThreadId: opts.claimedThreadId } : {}),
    // This entry's response echoes the executed commands, so a repeat of
    // the request has to find them in the stored outcome.
    echoCommands: true,
    ...(request.operationId !== undefined && opts?.principalId
      ? {
          request: {
            operationId: request.operationId,
            principalId: opts.principalId,
          },
        }
      : {}),
    issueBasis: true,
  });
  return projectRfsExecuteResponse(output, runId);
}

/** A stored result exists, but it is not the result of an RFS execute. */
export class NotAnRfsExecuteResultError extends Error {
  constructor(operationId: string, cause: unknown) {
    super(`Result ${operationId} was not stored by an RFS execute`, { cause });
    this.name = 'NotAnRfsExecuteResultError';
  }
}

/**
 * The stored response of an earlier request, exactly as a repeat of that
 * request would be answered, or null when nothing is stored under the id.
 *
 * @throws NotAnRfsExecuteResultError when the stored result cannot be
 *   expressed as an RFS execute response — it was saved through another entry
 *   point, with commands outside the agent vocabulary.
 */
export async function lookupRfsExecuteResponse(
  canvasId: string,
  key: SaveKey,
): Promise<RfsExecuteResponse | null> {
  const stored = await space(canvasId).save.lookup(normalizeSaveKey(key));
  if (!stored) return null;
  const outcome = readStoredOutcome(stored.response);
  if (!outcome || typeof outcome.runId !== 'string') return null;
  // Stored by an entry point whose response has no command echo.
  if (!outcome.commands && !outcome.incomplete) {
    throw new NotAnRfsExecuteResultError(
      key.operationId,
      new Error('The stored outcome keeps no commands'),
    );
  }
  try {
    return projectRfsExecuteResponse(replayedOutput(outcome), outcome.runId);
  } catch (error) {
    throw new NotAnRfsExecuteResultError(key.operationId, error);
  }
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
  // Built from the outcome only, so a repeated request — answered from the
  // stored outcome — gets the response the first call got.
  const outcome = outcomeOf(output, true);
  const commands = (outcome.commands ?? []).map(projectCommand);

  return {
    canvasId: outcome.canvasId,
    runId: outcome.runId ?? fallbackRunId,
    ...(outcome.operationId ? { operationId: outcome.operationId } : {}),
    ...(outcome.basis ? { basis: outcome.basis } : {}),
    ...(output.replayed ? { replayed: true as const } : {}),
    fromVersion: outcome.fromVersion,
    toVersion: outcome.toVersion,
    commands,
    results: outcome.results.map((result, index) => {
      const type = commands[index]?.type ?? result.type;
      if (!(AGENT_CANVAS_COMMAND_TYPES as readonly string[]).includes(type)) {
        throw new Error('Executor returned a result without a command');
      }
      return {
        index,
        type: type as (typeof AGENT_CANVAS_COMMAND_TYPES)[number],
        applied: result.applied,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.nodes ? { nodes: result.nodes } : {}),
        ...(result.edges ? { edges: result.edges } : {}),
      };
    }),
    revisions: outcome.revisions,
    affected: outcome.affected,
    ...(outcome.conflicts && outcome.conflicts.length > 0
      ? { conflicts: outcome.conflicts }
      : {}),
    // Only a request that stated its edits is answered per edit; the plain
    // command list keeps the response it always had.
    ...(outcome.statedAsEdits
      ? {
          edits: outcome.edits.map((edit) => ({
            applied: edit.applied,
            ...(edit.reason ? { reason: edit.reason } : {}),
            ...(edit.failedAt !== undefined ? { failedAt: edit.failedAt } : {}),
            start: edit.start,
            count: edit.count,
          })),
        }
      : {}),
    ...(outcome.incomplete ? { incomplete: true as const } : {}),
  };
}
