// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Which nodes of a committed write need preprocessing.
 *
 * The server decides this where the write is committed: it holds the Space
 * before and after, so "did this node's preprocessing input change" is a
 * comparison of two values it already has. It is decided once, whoever wrote
 * (a person's page, an Agent, another service) and however many pages are
 * open, including none.
 */

import { buildPreprocessSnapshot, type CanvasNodeType } from '@huabu/shared';

import { getProfile } from './profiles.js';

import type { CanvasNode } from '@huabu/shared/canvas-engine';

/** A node to preprocess, with what its request carried before the write. */
export interface PreprocessCandidate {
  node: CanvasNode;
  snapshot: Record<string, unknown>;
  /** Absent for a node the write created. */
  previousSnapshot?: Record<string, unknown>;
}

/**
 * Types whose pipeline does work. The others have a profile that only
 * resolves input and builds an empty patch.
 */
const PROCESSED_TYPES: ReadonlySet<string> = new Set<CanvasNodeType>([
  'note',
  'text',
  'web',
  'pdf',
  'office',
  'image',
  'video',
  'frame',
  'question',
]);

/**
 * `note` / `text` bodies are settled by the editor that was left, not by
 * every write: their title derives from the first heading, and deriving it
 * from each intermediate body renamed the file again and again.
 */
const SETTLED_BY_EDITOR: ReadonlySet<string> = new Set<CanvasNodeType>([
  'note',
  'text',
]);

/**
 * Types whose stored record holds something only preprocessing can produce
 * and no page ever holds: a PDF's extracted text, a video's cover. Deleting
 * the node deletes it, and an undo writes back only what the page had, so
 * these are derived again when they come back. Every other restored node
 * comes back complete, and deriving anything for it could only replace what
 * the undo just restored (a title, say) with something else.
 */
const DERIVED_AGAIN_ON_RESTORE: ReadonlySet<string> = new Set<CanvasNodeType>([
  'pdf',
  'video',
]);

function childIndex(
  nodes: readonly CanvasNode[],
): (frameId: string) => CanvasNode[] {
  let byParent: Map<string, CanvasNode[]> | undefined;
  return (frameId) => {
    if (!byParent) {
      byParent = new Map();
      for (const node of nodes) {
        if (!node.parentId) continue;
        const list = byParent.get(node.parentId);
        if (list) list.push(node);
        else byParent.set(node.parentId, [node]);
      }
    }
    return byParent.get(frameId) ?? [];
  };
}

const same = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The nodes a write created (or, for the types that need it, restored), or
 * whose watched preprocessing input it changed. A write that only moved, restyled or reordered a node selects
 * nothing.
 *
 * @param contentEditedNodeIds Nodes whose body a command of the write
 *   rewrote (`pendingEffects.contentEditedNodeIds`).
 */
export function selectNodesToPreprocess(input: {
  prestateNodes: readonly CanvasNode[];
  finalNodes: readonly CanvasNode[];
  contentEditedNodeIds: readonly string[];
  /** Nodes a `RESTORE_NODES` command put back (`CanvasCommit`). */
  restoredNodeIds?: readonly string[];
}): PreprocessCandidate[] {
  const { prestateNodes, finalNodes } = input;
  if (prestateNodes === finalNodes) return [];
  const before = new Map(prestateNodes.map((node) => [node.id, node]));
  const childrenBefore = childIndex(prestateNodes);
  const childrenAfter = childIndex(finalNodes);
  const bodyEdited = new Set(input.contentEditedNodeIds);
  const restored = new Set(input.restoredNodeIds ?? []);
  const candidates: PreprocessCandidate[] = [];

  for (const node of finalNodes) {
    const type = node.type ?? '';
    if (!PROCESSED_TYPES.has(type)) continue;
    const previous = before.get(node.id);
    // Untouched by the write: nothing to compare. A Frame is the exception,
    // because its input is its children's titles.
    if (previous === node && type !== 'frame') continue;
    const profile = getProfile(type as CanvasNodeType);
    if (!profile) continue;

    const snapshot = buildPreprocessSnapshot(node, childrenAfter);
    if (!previous) {
      if (!restored.has(node.id) || DERIVED_AGAIN_ON_RESTORE.has(type))
        candidates.push({ node, snapshot });
      continue;
    }
    const previousSnapshot = buildPreprocessSnapshot(previous, childrenBefore);
    const changed = profile.watchFields.some(
      (field) =>
        !(
          field === 'content' &&
          SETTLED_BY_EDITOR.has(type) &&
          bodyEdited.has(node.id)
        ) && !same(previousSnapshot[field], snapshot[field]),
    );
    if (changed) candidates.push({ node, snapshot, previousSnapshot });
  }
  return candidates;
}

/** A node's stored content as a preprocessing request sees it. */
function recordSnapshot(record: {
  label?: string | null;
  labelSource?: unknown;
  content?: string;
  src?: unknown;
}): Record<string, unknown> {
  return {
    title: record.label || undefined,
    labelSource: (record.labelSource as string) || undefined,
    content: record.content || undefined,
    src: (record.src as string) || undefined,
  };
}

/**
 * What a node-content save changed for the node's own preprocessing: its
 * title, who owns the title, or its source.
 *
 * A body is not among them. A page saves an authored body as it is typed and
 * asks for preprocessing when the editor is left; a derived body is written
 * by preprocessing itself. Nor is a title that ends up automatic: that is
 * what preprocessing produced, saved back, not a new input.
 */
export function selectAfterContentSave(input: {
  nodeId: string;
  nodeType: string;
  before: Parameters<typeof recordSnapshot>[0];
  after: Parameters<typeof recordSnapshot>[0];
}): {
  /** The saved node, when its own input changed. */
  node?: Omit<PreprocessCandidate, 'node'>;
  /** Whether a Frame holding the node reads a different child title now. */
  titleChanged: boolean;
} {
  const previousSnapshot = recordSnapshot(input.before);
  const snapshot = recordSnapshot(input.after);
  const sourceChanged = !same(previousSnapshot.src, snapshot.src);
  if (snapshot.labelSource === 'auto' && !sourceChanged)
    return { titleChanged: false };
  const titleChanged = !same(previousSnapshot.title, snapshot.title);
  const profile = PROCESSED_TYPES.has(input.nodeType)
    ? getProfile(input.nodeType as CanvasNodeType)
    : undefined;
  const changed =
    profile?.watchFields.some(
      (field) =>
        field !== 'content' && !same(previousSnapshot[field], snapshot[field]),
    ) ?? false;
  return {
    ...(changed ? { node: { snapshot, previousSnapshot } } : {}),
    titleChanged,
  };
}
