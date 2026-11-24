// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The outcome of an execute request: what a caller is told about it, and
 * what is stored under its request id to answer a repeat.
 *
 * An outcome is small by construction. It holds results per edit, the ids the
 * request touched, versions, order events and content revisions — never a
 * node, a body or a delta. Both entry points build their response from the
 * outcome (the page route adds the live deltas), so a stored outcome answers
 * a repeated request the way the first call was answered:
 *
 * - **A page** gets the same per-edit results, order events, content
 *   revisions and versions, marked `replayed: true`, and **no `deltas`**.
 *   What the request changed reached every page with the `update` event; a
 *   page that has not applied `toVersion` yet waits for that event or loads
 *   the Space.
 * - **An Agent** gets the response it got the first time, field for field:
 *   that response never carried deltas. Its echo of the executed commands is
 *   the one part of an outcome that grows with what the caller sent, so it
 *   is kept only for a caller whose response has it.
 *
 * An outcome that would still not fit a result record is stored without its
 * optional parts (`incomplete`) rather than not at all: a repeat of the
 * request must find it and must not execute again.
 */

import {
  collectCommandIds,
  nodeRevision,
  type CanvasNode,
  type Delta,
  type SetSiblingOrderEvent,
} from '@huabu/shared/canvas-engine';

import { SAVE_RESPONSE_MAX_BYTES } from '../storage/ports/save.js';

import type {
  ExecuteEditOutcome,
  ExecuteOnServerOutput,
  InteractiveViewConflict,
} from './canvas-executor.js';
import type {
  CanvasCommand,
  CanvasCommandFailureReason,
  ExecuteConflict,
} from '@huabu/shared';

/** One command's outcome, without the command. */
export interface StoredCommandOutcome {
  /** The command's type; the command itself is not kept here. */
  type: string;
  applied: boolean;
  reason?: CanvasCommandFailureReason;
  nodes?: NonNullable<ExecuteOnServerOutput['results'][number]['nodes']>;
  edges?: NonNullable<ExecuteOnServerOutput['results'][number]['edges']>;
}

export interface ExecuteOutcome {
  /** Format of the record. Records without it hold a whole response. */
  v: 2;
  canvasId: string;
  fromVersion: number;
  toVersion: number;
  runId?: string;
  operationId?: string;
  basis?: string;
  /** The request stated its edits (not a plain command list). */
  statedAsEdits?: true;
  /** One entry per edit, addressing `results` by `start` / `count`. */
  edits: ExecuteEditOutcome[];
  /** One entry per command across all edits. */
  results: StoredCommandOutcome[];
  /** Every node and edge id the request touched. */
  affected: {
    nodeIds: string[];
    edgeIds: string[];
    deletedNodeIds: string[];
    deletedEdgeIds: string[];
  };
  /** Content revision of every node the request created or whose data it changed. */
  revisions: { nodeId: string; rev: string }[];
  pendingEffects: {
    mutatedNodeIds: string[];
    deletedNodeIds: string[];
    contentEditedNodeIds: string[];
    deferredFitFrameIds: string[];
  };
  orderEvents?: SetSiblingOrderEvent[];
  nodeContentRevisions?: Record<string, string>;
  /** Body-revision refusals, without the body they echoed. */
  conflicts?: Omit<ExecuteConflict, 'currentContent'>[];
  viewConflicts?: InteractiveViewConflict[];
  /**
   * The commands as executed, for a caller whose response echoes them (the
   * Agent route). Absent otherwise.
   */
  commands?: CanvasCommand[];
  /**
   * Optional parts were left out so the record fits: the command echo, order
   * events, view conflicts and the per-command node and edge lists.
   */
  incomplete?: true;
}

function affectedOf(
  deltas: readonly Delta[],
  results: ExecuteOnServerOutput['results'],
): ExecuteOutcome['affected'] {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const deletedNodeIds = new Set<string>();
  const deletedEdgeIds = new Set<string>();
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
  for (const result of results) {
    if (result.applied && result.command)
      collectCommandIds(result.command, nodeIds, edgeIds);
  }
  return {
    nodeIds: [...nodeIds],
    edgeIds: [...edgeIds],
    deletedNodeIds: [...deletedNodeIds],
    deletedEdgeIds: [...deletedEdgeIds],
  };
}

function revisionsOf(
  mutatedNodes: readonly CanvasNode[],
): ExecuteOutcome['revisions'] {
  const byId = new Map(
    mutatedNodes.map((node) => [node.id, nodeRevision(node)]),
  );
  return [...byId].map(([nodeId, rev]) => ({ nodeId, rev }));
}

/**
 * The outcome of a call that just ran.
 *
 * @param echoCommands keep the executed commands, for a caller whose
 *   response echoes them.
 */
export function outcomeOf(
  output: ExecuteOnServerOutput,
  echoCommands: boolean,
): ExecuteOutcome {
  if (output.outcome) return output.outcome;
  return {
    v: 2,
    canvasId: output.canvasId,
    fromVersion: output.fromVersion,
    toVersion: output.toVersion,
    ...(output.runId ? { runId: output.runId } : {}),
    ...(output.operationId ? { operationId: output.operationId } : {}),
    ...(output.basis ? { basis: output.basis } : {}),
    ...(output.statedAsEdits ? { statedAsEdits: true as const } : {}),
    edits: output.edits,
    results: output.results.map((result, index) => ({
      type: result.command?.type ?? output.commands[index]?.type ?? '',
      applied: result.applied,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.nodes ? { nodes: result.nodes } : {}),
      ...(result.edges ? { edges: result.edges } : {}),
    })),
    affected: affectedOf(output.deltas, output.results),
    revisions: revisionsOf(output.pendingEffects.mutatedNodes),
    pendingEffects: {
      mutatedNodeIds: [
        ...new Set(output.pendingEffects.mutatedNodes.map((node) => node.id)),
      ],
      deletedNodeIds: output.pendingEffects.deletedNodeIds,
      contentEditedNodeIds: output.pendingEffects.contentEditedNodeIds,
      deferredFitFrameIds: output.pendingEffects.deferredFitFrameIds,
    },
    ...(output.orderEvents ? { orderEvents: output.orderEvents } : {}),
    ...(output.nodeContentRevisions
      ? { nodeContentRevisions: output.nodeContentRevisions }
      : {}),
    ...(output.conflicts && output.conflicts.length > 0
      ? {
          conflicts: output.conflicts.map(
            ({ currentContent: _currentContent, ...conflict }) => conflict,
          ),
        }
      : {}),
    ...(output.viewConflicts && output.viewConflicts.length > 0
      ? { viewConflicts: output.viewConflicts }
      : {}),
    ...(echoCommands ? { commands: output.commands } : {}),
  };
}

/** `outcome` without the parts a record can do without. */
function withoutOptionalParts(outcome: ExecuteOutcome): ExecuteOutcome {
  const {
    commands: _commands,
    orderEvents: _orderEvents,
    viewConflicts: _viewConflicts,
    ...rest
  } = outcome;
  return {
    ...rest,
    results: outcome.results.map(({ type, applied, reason }) => ({
      type,
      applied,
      ...(reason ? { reason } : {}),
    })),
    incomplete: true,
  };
}

/** `outcome` reduced to who, which versions and what became of each edit. */
function minimalOutcome(outcome: ExecuteOutcome): ExecuteOutcome {
  const reduced = withoutOptionalParts(outcome);
  const {
    nodeContentRevisions: _revisions,
    conflicts: _conflicts,
    ...rest
  } = reduced;
  return {
    ...rest,
    affected: {
      nodeIds: [],
      edgeIds: [],
      deletedNodeIds: [],
      deletedEdgeIds: [],
    },
    revisions: [],
    pendingEffects: {
      mutatedNodeIds: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    },
  };
}

/**
 * The form of `outcome` that fits a result record: whole when it fits,
 * otherwise without its optional parts, otherwise reduced to the per-edit
 * results. `null` only when even that does not fit (tens of thousands of
 * commands in one request) or the value is not plain JSON.
 *
 * @param maxBytes the record limit; a parameter for tests.
 */
export function storableOutcome(
  outcome: ExecuteOutcome,
  maxBytes: number = SAVE_RESPONSE_MAX_BYTES,
): ExecuteOutcome | null {
  for (const candidate of [
    () => outcome,
    () => withoutOptionalParts(outcome),
    () => minimalOutcome(outcome),
  ]) {
    const value = candidate();
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
      return null;
    }
    if (bytes <= maxBytes) return value;
  }
  return null;
}

/**
 * Read a stored record as an outcome.
 *
 * A record written before outcomes existed holds the whole response of that
 * call — commands, deltas and mutated nodes included. It is reduced here, so
 * a request made before an upgrade is still answered after it.
 */
export function readStoredOutcome(response: unknown): ExecuteOutcome | null {
  if (response === null || typeof response !== 'object') return null;
  const record = response as { v?: unknown };
  if (record.v === 2) return response as ExecuteOutcome;
  if (record.v !== undefined) return null;
  const legacy = response as Partial<ExecuteOnServerOutput>;
  if (
    typeof legacy.canvasId !== 'string' ||
    typeof legacy.fromVersion !== 'number' ||
    typeof legacy.toVersion !== 'number' ||
    !Array.isArray(legacy.results)
  )
    return null;
  const results = legacy.results;
  return outcomeOf(
    {
      canvasId: legacy.canvasId,
      fromVersion: legacy.fromVersion,
      toVersion: legacy.toVersion,
      deltas: Array.isArray(legacy.deltas) ? legacy.deltas : [],
      // The old form had no edits: each command stood for itself.
      edits: results.map((result, index) => ({
        applied: result.applied || result.reason === 'no-op',
        ...(result.reason && result.reason !== 'no-op'
          ? { reason: result.reason }
          : {}),
        ...(!result.applied && result.reason !== 'no-op'
          ? { failedAt: 0 }
          : {}),
        start: index,
        count: 1,
      })),
      results,
      commands: Array.isArray(legacy.commands) ? legacy.commands : [],
      pendingEffects: {
        mutatedNodes: legacy.pendingEffects?.mutatedNodes ?? [],
        deletedNodeIds: legacy.pendingEffects?.deletedNodeIds ?? [],
        contentEditedNodeIds: legacy.pendingEffects?.contentEditedNodeIds ?? [],
        deferredFitFrameIds: legacy.pendingEffects?.deferredFitFrameIds ?? [],
      },
      ...(legacy.conflicts ? { conflicts: legacy.conflicts } : {}),
      ...(legacy.viewConflicts ? { viewConflicts: legacy.viewConflicts } : {}),
      ...(legacy.orderEvents ? { orderEvents: legacy.orderEvents } : {}),
      ...(legacy.nodeContentRevisions
        ? { nodeContentRevisions: legacy.nodeContentRevisions }
        : {}),
      ...(legacy.basis ? { basis: legacy.basis } : {}),
      ...(legacy.operationId ? { operationId: legacy.operationId } : {}),
      ...(legacy.runId ? { runId: legacy.runId } : {}),
    },
    true,
  );
}

/**
 * The answer to a repeated request, from its stored outcome. It carries no
 * deltas and no nodes: `outcome` is what its consumers read.
 */
export function replayedOutput(outcome: ExecuteOutcome): ExecuteOnServerOutput {
  return {
    canvasId: outcome.canvasId,
    fromVersion: outcome.fromVersion,
    toVersion: outcome.toVersion,
    deltas: [],
    edits: outcome.edits,
    ...(outcome.statedAsEdits ? { statedAsEdits: true as const } : {}),
    results: outcome.results.map((result, index) => {
      const command = outcome.commands?.[index];
      return {
        ...(command ? { command } : {}),
        applied: result.applied,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.nodes ? { nodes: result.nodes } : {}),
        ...(result.edges ? { edges: result.edges } : {}),
      };
    }),
    commands: outcome.commands ?? [],
    pendingEffects: {
      mutatedNodes: [],
      deletedNodeIds: outcome.pendingEffects.deletedNodeIds,
      contentEditedNodeIds: outcome.pendingEffects.contentEditedNodeIds,
      deferredFitFrameIds: outcome.pendingEffects.deferredFitFrameIds,
    },
    ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}),
    ...(outcome.viewConflicts ? { viewConflicts: outcome.viewConflicts } : {}),
    ...(outcome.orderEvents ? { orderEvents: outcome.orderEvents } : {}),
    ...(outcome.nodeContentRevisions
      ? { nodeContentRevisions: outcome.nodeContentRevisions }
      : {}),
    ...(outcome.basis ? { basis: outcome.basis } : {}),
    ...(outcome.operationId ? { operationId: outcome.operationId } : {}),
    ...(outcome.runId ? { runId: outcome.runId } : {}),
    outcome,
    replayed: true,
  };
}
