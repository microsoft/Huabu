// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Canvas-owned application read models assembled from structured storage. */

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
    nodeWarnings: new Map(
      [...snapshots]
        .filter(([, snapshot]) => snapshot.warnings?.length)
        .map(([nodeId, snapshot]) => [nodeId, snapshot.warnings ?? []]),
    ),
  };
}

export async function streamCanvasNodes(
  canvasId: string,
  onNode: (nodeId: string, record: NodeContent) => void,
  signal?: { readonly aborted: boolean },
): Promise<ReadonlyMap<string, NodeContent>> {
  const snapshots = await getStructuredStore()
    .space(canvasId)
    .nodes.stream(
      (nodeId, snapshot) => onNode(nodeId, snapshot.record),
      signal,
    );
  return nodeRecords(snapshots);
}
