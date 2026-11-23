// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What the server does about a write once it is committed.
 *
 * Writes are committed in two places: the executor (command batches, from
 * pages and Agents alike) and the node-content save (a title, a source or a
 * body a page saves). Neither knows what a write implies for other
 * subsystems. A subsystem that reacts to committed writes (today:
 * preprocessing) installs itself here when the server is assembled, so the
 * dependency points from that subsystem to the write paths and not back.
 */

import type { NodeContent } from '../storage/index.js';
import type { CanvasNode, Delta } from '@huabu/shared/canvas-engine';

/** A command batch as the executor committed it. */
export interface CanvasCommit {
  canvasId: string;
  /**
   * What the batch changed, as diffed: per node the fields that changed,
   * and a deletion still holding the node.
   */
  deltas: readonly Delta[];
  prestateNodes: readonly CanvasNode[];
  finalNodes: readonly CanvasNode[];
  /** Nodes a `RESTORE_NODES` command of the batch put back (an undo). */
  restoredNodeIds: readonly string[];
}

/** One node's stored content as the content save replaced it. */
export interface NodeContentSave {
  canvasId: string;
  nodeId: string;
  nodeType: string;
  before: NodeContent;
  after: NodeContent;
  /** The save said the person left the node's editor. */
  editingEnded?: boolean;
  /** The Space's nodes as stored: structure only, no content fields. */
  storedNodes: readonly { id: string; type?: string; parentId?: string }[];
}

/** Starts the follow-up work. Called after the write has been announced. */
export type StartFollowUp = () => void;

export interface CommitReactions {
  batch(commit: CanvasCommit): StartFollowUp | undefined;
  contentSave(save: NodeContentSave): StartFollowUp | undefined;
  /**
   * An Agent Node an undo brought back is associated with its conversation
   * again. That write goes through neither path above.
   */
  agentNodeRestored(
    canvasId: string,
    node: CanvasNode,
  ): StartFollowUp | undefined;
}

let installed: CommitReactions | undefined;

/** Install (or, with `undefined`, remove) the reactions to committed writes. */
export function setCommitReactions(
  reactions: CommitReactions | undefined,
): void {
  installed = reactions;
}

/** The installed reactions, or nothing when the server has none. */
export function commitReactions(): CommitReactions | undefined {
  return installed;
}
