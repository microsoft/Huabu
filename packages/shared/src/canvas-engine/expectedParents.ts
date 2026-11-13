// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Expected parents: the container each node of one edit was in when the
 * edit was made.
 *
 * A position is relative to the node's parent, a cell belongs to one Frame
 * and "before X" is a place among X's siblings. A writer that does not quote
 * a read version (a browser page) can instead say, for one run of commands
 * that form a single edit, which parent each node it places had when the
 * edit was made. When a node's parent is no longer that one — another writer
 * moved it into or out of a Frame first — the whole run is refused instead
 * of being read against a container its author never saw.
 *
 * The check is a precondition on the state the run starts from, so refusing
 * needs no rollback: either every command of the run is admitted or none is.
 * It plugs into the executor's `admit` hook and reports the read-version
 * check's reasons (`stale-parent`, `stale-target`).
 *
 * Pure functions only.
 */

import { stripLegacyPortalTopology } from '../utils/strip-legacy-portal-topology.js';

import type { ExecutorOptions } from './executor.js';
import type { CanvasCommand, CanvasCommandFailureReason } from '../index.js';

/** One edit's commands and the parents they were made under. */
export interface ExpectedParents {
  /** Index of the edit's first command in the batch. */
  readonly start: number;
  /** How many consecutive commands belong to the edit. */
  readonly count: number;
  /**
   * Node id → the parent that node had when the edit was made; `null` is the
   * canvas itself.
   */
  readonly parents: Readonly<Record<string, string | null>>;
}

/**
 * The nodes whose parent a command's meaning depends on.
 *
 * - `SET_NODE_GEOMETRY`: every item that carries a `position` (parent-local
 *   coordinates). A size alone means the same in any container.
 * - `SET_NODE_PARENT`: `nodeIds` — the command moves them *from* the parent
 *   they had, and the position each ends at is converted from it.
 * - `REORDER_NODES`: `nodeIds` and the `before` / `after` reference node
 *   (sibling order is per parent).
 * - `ALIGN_NODES`, `DISTRIBUTE_NODES`: `nodeIds` (computed per parent group).
 * - `SET_FRAME_LAYOUT`: every `cells[].nodeId` and every `placements[]`
 *   `nodeId` / `before` / `after` (a cell or a track place in that Frame).
 * - every other command: none.
 */
export function commandPlacementTargets(command: CanvasCommand): string[] {
  const ids = new Set<string>();
  const add = (id: string | null | undefined): void => {
    if (typeof id === 'string' && id) ids.add(id);
  };
  switch (command.type) {
    case 'SET_NODE_GEOMETRY':
      for (const item of command.items) if (item.position) add(item.nodeId);
      break;
    case 'SET_NODE_PARENT':
    case 'ALIGN_NODES':
    case 'DISTRIBUTE_NODES':
      for (const nodeId of command.nodeIds) add(nodeId);
      break;
    case 'REORDER_NODES':
      for (const nodeId of command.nodeIds) add(nodeId);
      if (typeof command.to === 'object')
        add('before' in command.to ? command.to.before : command.to.after);
      break;
    case 'SET_FRAME_LAYOUT':
      for (const cell of command.cells ?? []) add(cell.nodeId);
      for (const placement of command.placements ?? []) {
        const named = placement as {
          nodeId?: string;
          before?: string;
          after?: string;
        };
        add(named.nodeId);
        add(named.before);
        add(named.after);
      }
      break;
    default:
      break;
  }
  return [...ids];
}

/**
 * The parents one edit's commands were made under, read from the nodes as
 * their author saw them. Nodes the author did not have (the edit creates or
 * restores them itself) are left out. `null` when the commands place nothing.
 */
export function expectedParentsOf(
  commands: readonly CanvasCommand[],
  nodes: readonly { id: string; parentId?: string | null }[],
): Record<string, string | null> | null {
  const wanted = new Set<string>();
  for (const command of commands)
    for (const id of commandPlacementTargets(command)) wanted.add(id);
  if (wanted.size === 0) return null;
  const parents: Record<string, string | null> = {};
  let found = false;
  for (const node of nodes) {
    if (!wanted.has(node.id)) continue;
    parents[node.id] = node.parentId ?? null;
    found = true;
  }
  return found ? parents : null;
}

/**
 * Why `expected` cannot describe a batch of `commandCount` commands, or
 * `null` when it can: every run lies inside the batch and no two overlap.
 */
export function expectedParentsProblem(
  expected: readonly ExpectedParents[],
  commandCount: number,
): string | null {
  const taken = new Set<number>();
  for (const run of expected) {
    if (run.start + run.count > commandCount)
      return 'expectedParents names commands the request does not have';
    for (let index = run.start; index < run.start + run.count; index++) {
      if (taken.has(index))
        return 'expectedParents names the same command twice';
      taken.add(index);
    }
  }
  return null;
}

/**
 * Build the engine's `admit` hook for a batch whose author stated the
 * parents its edits were made under.
 *
 * Each run is judged once, when its first command is reached, against the
 * state that command would run against — so it already reflects earlier
 * commands of the batch, including an earlier edit of the same author that
 * was itself refused. A node that no longer exists refuses the run with
 * `stale-target`; a node under another parent refuses it with
 * `stale-parent`. The verdict applies to every command of the run. Commands
 * outside every run are admitted.
 *
 * @param commands The batch exactly as the executor will receive it; runs
 *   address it by index.
 */
export function createExpectedParentsAdmit(
  commands: readonly CanvasCommand[],
  expected: readonly ExpectedParents[],
): NonNullable<ExecutorOptions['admit']> {
  const runOf = new Map<CanvasCommand, ExpectedParents>();
  for (const run of expected) {
    for (let index = run.start; index < run.start + run.count; index++) {
      const command = commands[index];
      if (command && !runOf.has(command)) runOf.set(command, run);
    }
  }
  const verdicts = new Map<
    ExpectedParents,
    CanvasCommandFailureReason | undefined
  >();

  return (command, state) => {
    const run = runOf.get(command);
    if (!run) return undefined;
    if (verdicts.has(run)) return verdicts.get(run);
    // Parents as a page sees them: a node under a retired portal node, or
    // under a parent that does not exist, is shown on the canvas.
    const shown = stripLegacyPortalTopology(state.nodes, []).nodes;
    const ids = new Set(shown.map((node) => node.id));
    const parentOf = new Map<string, string | null>();
    for (const node of shown) {
      parentOf.set(
        node.id,
        node.parentId && ids.has(node.parentId) ? node.parentId : null,
      );
    }
    let verdict: CanvasCommandFailureReason | undefined;
    for (const [nodeId, parentId] of Object.entries(run.parents)) {
      if (!parentOf.has(nodeId)) {
        verdict = 'stale-target';
        break;
      }
      if (parentOf.get(nodeId) !== (parentId ?? null))
        verdict ??= 'stale-parent';
    }
    verdicts.set(run, verdict);
    return verdict;
  };
}
