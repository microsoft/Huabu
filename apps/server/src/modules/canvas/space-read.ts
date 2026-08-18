// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas-owned application read models assembled from structured storage.
 *
 * Two shapes, and the choice between them is about cost, not convenience.
 * {@link readCanvasSnapshot} reads the record and *every* node, which is what
 * a whole-Space job needs — hydrating a prestate, serving the Space to a
 * client. {@link readCanvasNodesFor} reads the record and only the nodes
 * named, which is what most callers actually want: a selection to describe, a
 * neighbourhood to render, one view to serve. Reaching for the snapshot when
 * a handful of ids would do makes the request cost grow with the Space.
 */

import { getStructuredStore } from '../storage/index.js';

import type { CanvasFile, NodeContent } from './persistence-types.js';
import type { NodeReadWarning } from '../storage/index.js';

export interface CanvasReadSnapshot {
  readonly canvas: CanvasFile;
  readonly nodes: ReadonlyMap<string, NodeContent>;
  readonly nodeWarnings: ReadonlyMap<string, readonly NodeReadWarning[]>;
}

function nodeRecords(
  snapshots: ReadonlyMap<
    string,
    { readonly record: NodeContent; readonly revision: string }
  >,
): ReadonlyMap<string, NodeContent> {
  return new Map(
    [...snapshots].map(([nodeId, snapshot]) => [nodeId, snapshot.record]),
  );
}

export async function readCanvas(canvasId: string): Promise<CanvasFile | null> {
  return getStructuredStore().space(canvasId).read();
}

export async function readCanvasNode(
  canvasId: string,
  nodeId: string,
): Promise<NodeContent | null> {
  return (
    (await getStructuredStore().space(canvasId).nodes.read(nodeId))?.record ??
    null
  );
}

function warningsOf(
  snapshots: ReadonlyMap<
    string,
    { readonly warnings?: readonly NodeReadWarning[] }
  >,
): ReadonlyMap<string, readonly NodeReadWarning[]> {
  return new Map(
    [...snapshots]
      .filter(([, snapshot]) => snapshot.warnings?.length)
      .map(([nodeId, snapshot]) => [nodeId, snapshot.warnings ?? []]),
  );
}

/** The Space record and every node record it holds. */
export async function readCanvasSnapshot(
  canvasId: string,
): Promise<CanvasReadSnapshot | null> {
  const handle = getStructuredStore().space(canvasId);
  const canvas = await handle.read();
  if (!canvas) return null;
  const snapshots = await handle.nodes.list();
  return {
    canvas,
    nodes: nodeRecords(snapshots),
    nodeWarnings: warningsOf(snapshots),
  };
}

/**
 * The Space record plus the node records for `nodeIds` only.
 *
 * `nodes` is keyed the same way {@link readCanvasSnapshot} keys it and omits
 * ids that hold no record, so a caller can read either one through the same
 * lookups. Ids that are not in this Space simply do not appear.
 */
export async function readCanvasNodesFor(
  canvasId: string,
  nodeIds: Iterable<string>,
): Promise<CanvasReadSnapshot | null> {
  const handle = getStructuredStore().space(canvasId);
  const canvas = await handle.read();
  if (!canvas) return null;
  const snapshots = await handle.nodes.readMany(nodeIds);
  return {
    canvas,
    nodes: nodeRecords(snapshots),
    nodeWarnings: warningsOf(snapshots),
  };
}

/** Node records for `nodeIds`, without re-reading the Space record. */
export async function readCanvasNodes(
  canvasId: string,
  nodeIds: Iterable<string>,
): Promise<ReadonlyMap<string, NodeContent>> {
  return nodeRecords(
    await getStructuredStore().space(canvasId).nodes.readMany(nodeIds),
  );
}
