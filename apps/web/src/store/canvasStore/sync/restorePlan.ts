// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The commands that save an undo or redo.
 *
 * An undo already ran on this page: `target` is the state it shows. This
 * module works out what to send so the server reaches the same state.
 *
 * 1. The per-property proposal ({@link commandsForStateDiff}): moves,
 *    sizes, data keys set or removed, reparenting, deletions, and
 *    `RESTORE_NODES` for nodes that come back. These leave what another
 *    page changed on the same nodes alone.
 * 2. The proposal is run through the engine. Whatever a surviving node
 *    still differs in (a type change, a lock, another top-level field) is
 *    put back by replacing that node whole; then sibling order and edges
 *    are compared again and repaired.
 * 3. The whole list is run once more, as the one batch the server will run,
 *    and compared with `target`. `exact` reports whether it matched; when
 *    it did not (the engine fitted a Frame or routed an edge differently
 *    from the snapshot), `result` is what the server will hold, for the
 *    page to show instead.
 *
 * Agent Nodes that come back are left out: their identity is restored by
 * the association endpoint, not by a command. Their edges and their place
 * in the sibling order go into `followUp`, to be sent once they exist.
 *
 * Pure functions only; the engine is passed in.
 */

import deepEqual from 'fast-deep-equal';

import {
  normalizeTreeOrder,
  stripTransientEdgeFields,
  stripTransientNodeFields,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import { deriveHeldKeys, EXISTENCE_UNIT, parseKey } from './inFlight';
import { commandsForStateDiff, reorderCommands } from './localDiffCommands';

import type { UnitNode } from './propertyUnits';
import type {
  CanvasCommand,
  CanvasEdgeId,
  CanvasNodeId,
  CanvasRestoredEdge,
  CanvasRestoredNode,
} from '@huabu/shared';

type PlanEdge = { id: string; source: string; target: string } & Record<
  string,
  unknown
>;

export interface PlanState {
  nodes: readonly UnitNode[];
  edges: readonly PlanEdge[];
}

export interface RestorePlan {
  /** The batch that takes the server from `before` to `target`. */
  commands: CanvasCommand[];
  /** Sent after the returning Agent Nodes exist: their order and edges. */
  followUp: CanvasCommand[];
  /** Nodes the batch puts back with `RESTORE_NODES` (never Agent Nodes). */
  restoredNodeIds: string[];
  /** Agent Nodes that come back, for the association endpoint. */
  restoredQuestionIds: string[];
  /** Whether running `commands` on `before` gives `target` exactly. */
  exact: boolean;
  /**
   * What running `commands` on `before` gives — what the server will hold,
   * without the returning Agent Nodes and their edges.
   */
  result: PlanState;
}

export interface RestorePlanInput {
  before: PlanState;
  target: PlanState;
  /** Units another writer saves; not compared and not sent. */
  ignoreUnit: (unit: string) => boolean;
  /** `data` keys a replaced node keeps (content fields). */
  contentKeys: ReadonlySet<string>;
  /** Run `commands` on `before` as one `ui` batch. */
  run: (commands: CanvasCommand[]) => PlanState;
}

function withoutData(
  node: UnitNode,
  keys: ReadonlySet<string>,
): CanvasRestoredNode {
  const stripped = stripTransientNodeFields(node) as UnitNode;
  const data = { ...((stripped.data ?? {}) as Record<string, unknown>) };
  for (const key of keys) delete data[key];
  return { ...stripped, data } as unknown as CanvasRestoredNode;
}

export function planRestore(input: RestorePlanInput): RestorePlan {
  const { before, target, ignoreUnit, contentKeys, run } = input;
  const beforeIds = new Set(before.nodes.map((node) => node.id));
  const questions = target.nodes.filter(
    (node) => node.type === 'question' && !beforeIds.has(node.id),
  );
  const questionIds = new Set(questions.map((node) => node.id));
  const touchesQuestion = (edge: PlanEdge): boolean =>
    questionIds.has(edge.source) || questionIds.has(edge.target);
  const core: PlanState =
    questions.length === 0
      ? target
      : {
          nodes: target.nodes.filter((node) => !questionIds.has(node.id)),
          edges: target.edges.filter((edge) => !touchesQuestion(edge)),
        };

  const commands = [...commandsForStateDiff(before, core, ignoreUnit).commands];
  const restoredNodeIds = core.nodes
    .filter((node) => !beforeIds.has(node.id))
    .map((node) => node.id);
  let result = commands.length > 0 ? run(commands) : before;

  // Nodes that still differ are replaced whole.
  const differing = new Set<string>();
  for (const key of deriveHeldKeys(result, core, ignoreUnit).keys()) {
    const parsed = parseKey(key);
    if (parsed?.kind === 'node' && parsed.unit !== EXISTENCE_UNIT)
      differing.add(parsed.nodeId);
  }
  if (differing.size > 0) {
    commands.push({
      type: 'RESTORE_NODES',
      nodes: core.nodes
        .filter((node) => differing.has(node.id))
        .map((node) => withoutData(node, contentKeys)),
      replace: [...differing] as CanvasNodeId[],
      keepDataKeys: [...contentKeys],
    });
    result = run(commands);
  }

  const reorder = reorderCommands(result.nodes, core.nodes);
  const resultEdges = new Map(result.edges.map((edge) => [edge.id, edge]));
  const coreEdgeIds = new Set(core.edges.map((edge) => edge.id));
  const strayEdges = result.edges.filter((edge) => !coreEdgeIds.has(edge.id));
  const wrongEdges = core.edges.filter((edge) => {
    const current = resultEdges.get(edge.id);
    return (
      !current ||
      !deepEqual(
        stripTransientEdgeFields(current),
        stripTransientEdgeFields(edge),
      )
    );
  });
  if (reorder.length > 0 || strayEdges.length > 0 || wrongEdges.length > 0) {
    commands.push(...reorder);
    if (strayEdges.length > 0) {
      commands.push({
        type: 'DISCONNECT_EDGES',
        edges: strayEdges.map((edge) => edge.id as CanvasEdgeId),
      });
    }
    if (wrongEdges.length > 0) {
      commands.push({
        type: 'RESTORE_NODES',
        nodes: [],
        edges: wrongEdges.map(
          (edge) => stripTransientEdgeFields(edge) as CanvasRestoredEdge,
        ),
      });
    }
    result = run(commands);
  }

  const exact = deriveHeldKeys(result, core, ignoreUnit).size === 0;

  const followUp: CanvasCommand[] = [];
  if (questions.length > 0) {
    // The association appends each Agent Node; say where it belongs.
    const appended = normalizeTreeOrder([
      ...(result.nodes as unknown as NestableNode[]),
      ...(questions as unknown as NestableNode[]),
    ]) as unknown as UnitNode[];
    followUp.push(...reorderCommands(appended, target.nodes));
    const edges = target.edges.filter(touchesQuestion);
    if (edges.length > 0) {
      followUp.push({
        type: 'RESTORE_NODES',
        nodes: [],
        edges: edges.map(
          (edge) => stripTransientEdgeFields(edge) as CanvasRestoredEdge,
        ),
      });
    }
  }

  return {
    commands,
    followUp,
    restoredNodeIds,
    restoredQuestionIds: [...questionIds],
    exact,
    result,
  };
}
