// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Read-version check: is a write still about the nodes its author saw?
 *
 * A writer quotes the Space version it read. Per node the Space keeps the
 * version at which the node was created and at which its parent last changed
 * ({@link NodeStamp}), so the question is answered for exactly the nodes a
 * command names ({@link commandReadTargets}) — never by comparing the quoted
 * version with the head, so unrelated writes by others do not get in the way.
 *
 * A version is quoted per **edit**: the commands of one intent. An edit is
 * judged once, before its first command, against the state it would run
 * against, so it is taken or refused as a whole. A legacy `{ commands }`
 * request is one edit per command, each quoting the request's version, so
 * there each command is judged on its own.
 *
 * A change the same page committed itself is not a change it has not seen:
 * a stamp newer than the quoted version does not make a target stale when
 * that page made it (`createdBy` / `membershipBy`).
 *
 * Pure functions only; storage of the stamps is the host's.
 */

import { commandReadTargets } from './commandTargets.js';

import type { ExecutorOptions } from './executor.js';
import type { CanvasCommand, CanvasCommandFailureReason } from '../index.js';

/** When one node last came into existence and last changed parent. */
export interface NodeStamp {
  /** Space version at which this node id (last) came into existence. */
  readonly created: number;
  /** Space version at which this node's parent last changed. */
  readonly membership: number;
  /** The page whose write created the node, when it was a page's. */
  readonly createdBy?: string;
  /** The page whose write last changed the node's parent, likewise. */
  readonly membershipBy?: string;
}

export interface ReadStamps {
  /** Version the stamps start at; an unstamped node counts as changed then. */
  readonly floor: number;
  /** Sparse: an absent node means `{ created: floor, membership: floor }`. */
  readonly nodes: Readonly<Record<string, NodeStamp>>;
}

/** Who a write's existence and membership changes are attributed to. */
export interface StampAuthor {
  /** Opaque page key; see {@link NodeStamp.createdBy}. */
  readonly by: string;
  /**
   * Nodes whose parent change in this write is not attributed: the write
   * moved them as a consequence, and the author had not seen their last
   * parent change.
   */
  readonly except?: ReadonlySet<string>;
}

type TopologyNode = { id?: unknown; parentId?: unknown };

function topologyOf(nodes: readonly unknown[]): Map<string, string | null> {
  const topology = new Map<string, string | null>();
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue;
    const { id, parentId } = node as TopologyNode;
    if (typeof id !== 'string' || id.length === 0) continue;
    topology.set(
      id,
      typeof parentId === 'string' && parentId ? parentId : null,
    );
  }
  return topology;
}

/**
 * Advance node stamps across one committed write.
 *
 * A new id is stamped `{ to, to }`; an id whose `parentId` changed gets
 * `membership = to`; a removed id is dropped, so recreating it later stamps
 * it as new. With an `author` the new stamp names it; without one — or for a
 * node in `author.except` — it names nobody, which also forgets who made the
 * change before. When nothing about existence or membership changed the very
 * object passed in is returned, so a host can skip persisting it.
 */
export function advanceNodeStamps(
  prev: ReadStamps,
  prevNodes: readonly unknown[],
  nextNodes: readonly unknown[],
  toVersion: number,
  author?: StampAuthor,
): Readonly<Record<string, NodeStamp>> {
  const before = topologyOf(prevNodes);
  const after = topologyOf(nextNodes);
  let nodes: Record<string, NodeStamp> | null = null;
  const editable = (): Record<string, NodeStamp> => {
    nodes ??= { ...prev.nodes };
    return nodes;
  };

  for (const [id, parent] of after) {
    if (!before.has(id)) {
      editable()[id] = {
        created: toVersion,
        membership: toVersion,
        ...(author ? { createdBy: author.by, membershipBy: author.by } : {}),
      };
    } else if (before.get(id) !== parent) {
      const earlier = prev.nodes[id];
      editable()[id] = {
        created: earlier?.created ?? prev.floor,
        membership: toVersion,
        ...(earlier?.createdBy ? { createdBy: earlier.createdBy } : {}),
        ...(author && !author.except?.has(id)
          ? { membershipBy: author.by }
          : {}),
      };
    }
  }
  for (const id of Object.keys(prev.nodes)) {
    if (!after.has(id)) delete editable()[id];
  }
  return nodes ?? prev.nodes;
}

/** One edit of a batch as the read-version check sees it. */
export interface ReadVersionEdit {
  readonly commands: readonly CanvasCommand[];
  /**
   * The Space version the edit was made on. Without one the edit is admitted
   * unchecked.
   */
  readonly version?: number;
}

export interface ReadVersionAdmission {
  /** The engine's `admitEdit` hook for the batch. */
  readonly admitEdit: NonNullable<ExecutorOptions['admitEdit']>;
  /**
   * After the batch ran: the nodes whose parent it changed without the
   * author having seen their last parent change — {@link StampAuthor.except}.
   */
  unseenMoves(finalNodes: readonly unknown[]): Set<string>;
}

/**
 * Build the engine's `admitEdit` hook for one batch.
 *
 * - A target that is missing from the state the edit starts from, or that
 *   was created after the quoted version by someone else, refuses with
 *   `stale-target`.
 * - A membership target whose parent changed after the quoted version, by
 *   someone else, refuses with `stale-parent`.
 * - A node this batch itself brought into existence — an id absent from the
 *   prestate, or one an earlier edit of the batch removed and a later one
 *   created again — is never stale: its author is the caller.
 * - An edit is judged once, over all its commands, against the state its
 *   first command would run against; the verdict applies to the whole edit.
 *
 * Stamps describe the prestate, so what earlier edits of the same batch did
 * to a node never counts against a later one. (An edit made on top of an
 * edit that did not take effect is refused by the engine itself.)
 *
 * @param input.edits the batch, edit for edit as the engine will run it.
 * @param input.page the page the batch comes from, as stamps name it.
 * @param input.exempt commands the host added to the batch itself; they
 *   follow from an authored command and are not checked on their own.
 */
export function createReadVersionAdmission(input: {
  readonly edits: readonly ReadVersionEdit[];
  readonly stamps: ReadStamps;
  readonly prestateNodes: readonly { id: string; parentId?: unknown }[];
  readonly page?: string;
  readonly exempt?: ReadonlySet<CanvasCommand>;
}): ReadVersionAdmission {
  const { stamps, exempt, page, edits } = input;
  const prestateIds = new Set(input.prestateNodes.map((node) => node.id));
  /** Prestate ids seen absent at some point of the batch. */
  const removedInBatch = new Set<string>();
  /** Membership targets of admitted edits: their author saw them. */
  const seenMembership = new Set<string>();

  const madeByBatch = (id: string): boolean =>
    !prestateIds.has(id) || removedInBatch.has(id);
  const staleExistence = (id: string, version: number): boolean => {
    const stamp = stamps.nodes[id];
    if ((stamp?.created ?? stamps.floor) <= version) return false;
    return page === undefined || stamp?.createdBy !== page;
  };
  const staleMembership = (id: string, version: number): boolean => {
    const stamp = stamps.nodes[id];
    if ((stamp?.membership ?? stamps.floor) <= version) return false;
    return page === undefined || stamp?.membershipBy !== page;
  };

  /** Judge `judged` as one unit against the ids present before it. */
  const judge = (
    judged: readonly CanvasCommand[],
    present: ReadonlySet<string>,
    version: number,
  ): CanvasCommandFailureReason | undefined => {
    let verdict: CanvasCommandFailureReason | undefined;
    const membership: string[] = [];
    /** Ids an earlier command of `judged` creates. */
    const made = new Set<string>();
    for (const command of judged) {
      const targets = commandReadTargets(command);
      for (const id of targets.existence) {
        if (made.has(id)) continue;
        if (!present.has(id)) return 'stale-target';
        if (madeByBatch(id)) continue;
        if (staleExistence(id, version)) return 'stale-target';
      }
      for (const id of targets.membership) {
        if (made.has(id) || madeByBatch(id)) continue;
        if (staleMembership(id, version)) verdict ??= 'stale-parent';
        else membership.push(id);
      }
      if (command.type === 'CREATE_NODES' || command.type === 'RESTORE_NODES') {
        for (const node of command.nodes ?? []) {
          if (node.id && !present.has(node.id)) made.add(node.id);
        }
      }
      if (
        command.type === 'INITIALIZE_PDF_NOTE' &&
        command.noteId &&
        !present.has(command.noteId)
      )
        made.add(command.noteId);
    }
    if (verdict === undefined)
      for (const id of membership) seenMembership.add(id);
    return verdict;
  };

  const admitEdit: ReadVersionAdmission['admitEdit'] = (
    _edit,
    index,
    state,
  ) => {
    const present = new Set<string>(state.nodes.map((node) => node.id));
    for (const id of prestateIds) {
      if (!present.has(id)) removedInBatch.add(id);
    }
    const edit = edits[index];
    if (!edit || edit.version === undefined) return undefined;
    const judged = exempt
      ? edit.commands.filter((command) => !exempt.has(command))
      : edit.commands;
    return judge(judged, present, edit.version);
  };

  return {
    admitEdit,
    unseenMoves(finalNodes) {
      const versions = edits.flatMap((edit) =>
        edit.version === undefined ? [] : [edit.version],
      );
      const oldest = versions.length > 0 ? Math.min(...versions) : -1;
      const before = topologyOf(input.prestateNodes);
      const unseen = new Set<string>();
      for (const [id, parent] of topologyOf(finalNodes)) {
        if (!before.has(id) || before.get(id) === parent) continue;
        if (seenMembership.has(id)) continue;
        if (staleMembership(id, oldest)) unseen.add(id);
      }
      return unseen;
    },
  };
}
