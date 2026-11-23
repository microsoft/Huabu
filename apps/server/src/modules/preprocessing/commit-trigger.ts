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

import type { CanvasNode, Delta } from '@huabu/shared/canvas-engine';

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

/** Lookups over one node array, each built on first use. */
function indexNodes(nodes: readonly CanvasNode[]) {
  let byId: Map<string, CanvasNode> | undefined;
  let byParent: Map<string, CanvasNode[]> | undefined;
  return {
    get(id: string): CanvasNode | undefined {
      byId ??= new Map(nodes.map((node) => [node.id, node]));
      return byId.get(id);
    },
    childrenOf(frameId: string): CanvasNode[] {
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
    },
  };
}

const same = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** The node data key each watched snapshot field is read from. */
const DATA_KEY_OF_FIELD: Record<string, string> = {
  title: 'label',
  labelSource: 'labelSource',
  content: 'content',
  src: 'src',
};

/**
 * The nodes a write created (or, for the types that need it, restored), or
 * whose watched preprocessing input it changed. A write that only moved,
 * restyled or reordered a node selects nothing.
 *
 * It starts from the batch's change rows, which already name each changed
 * node and field, so the cost follows what the batch changed and not the
 * size of the Space: a row that touches no watched field is skipped without
 * looking at the node, and nothing is indexed unless a candidate is found.
 */
export function selectNodesToPreprocess(input: {
  /** The batch's rows as diffed: a deletion still holds the node. */
  deltas: readonly Delta[];
  prestateNodes: readonly CanvasNode[];
  finalNodes: readonly CanvasNode[];
  /** Nodes whose body a command of the write rewrote. */
  contentEditedNodeIds: readonly string[];
  /** Nodes a `RESTORE_NODES` command put back (`CanvasCommit`). */
  restoredNodeIds?: readonly string[];
}): PreprocessCandidate[] {
  const before = indexNodes(input.prestateNodes);
  const after = indexNodes(input.finalNodes);
  const bodyEdited = new Set(input.contentEditedNodeIds);
  const restored = new Set(input.restoredNodeIds ?? []);
  const candidates: PreprocessCandidate[] = [];
  /** Frames whose children, or whose children's titles, a row changed. */
  const frames = new Set<string>();
  const noteParent = (parentId: unknown): void => {
    if (typeof parentId === 'string' && parentId) frames.add(parentId);
  };

  for (const delta of input.deltas) {
    if (delta.type === 'INSERT_NODE') {
      const node = delta.node;
      noteParent(node.parentId);
      const type = node.type ?? '';
      if (!PROCESSED_TYPES.has(type)) continue;
      if (restored.has(node.id) && !DERIVED_AGAIN_ON_RESTORE.has(type))
        continue;
      const stored = after.get(node.id);
      if (stored)
        candidates.push({
          node: stored,
          snapshot: buildPreprocessSnapshot(stored, after.childrenOf),
        });
      continue;
    }
    if (delta.type === 'DELETE_NODE') {
      noteParent(delta.node.parentId);
      continue;
    }
    if (delta.type !== 'REPLACE_NODE') continue;

    const { prev, next } = delta;
    const changedData = { ...prev.data, ...next.data };
    const parentChanged = 'parentId' in prev || 'parentId' in next;
    const titleChanged = 'label' in changedData;
    if (parentChanged) {
      noteParent(prev.parentId);
      noteParent(next.parentId);
    } else if (titleChanged) {
      noteParent(after.get(next.id)?.parentId);
    }

    const type = delta.nodeType ?? '';
    if (type === 'frame') {
      // Its own input is its children's titles, decided below.
      if ('labelSource' in changedData) frames.add(next.id);
      continue;
    }
    if (!PROCESSED_TYPES.has(type)) continue;
    const profile = getProfile(type as CanvasNodeType);
    const touched = profile?.watchFields.some((field) => {
      const key = DATA_KEY_OF_FIELD[field];
      return (
        key !== undefined &&
        key in changedData &&
        !(
          field === 'content' &&
          SETTLED_BY_EDITOR.has(type) &&
          bodyEdited.has(next.id)
        )
      );
    });
    if (!touched) continue;
    const node = after.get(next.id);
    const previous = before.get(next.id);
    if (!node || !previous) continue;
    candidates.push({
      node,
      snapshot: buildPreprocessSnapshot(node, after.childrenOf),
      previousSnapshot: buildPreprocessSnapshot(previous, before.childrenOf),
    });
  }

  const selected = new Set(candidates.map((candidate) => candidate.node.id));
  for (const frameId of frames) {
    if (selected.has(frameId)) continue;
    const node = after.get(frameId);
    const previous = before.get(frameId);
    // Created in this batch (selected above), deleted, or not a Frame.
    if (!node || !previous || node.type !== 'frame') continue;
    const snapshot = buildPreprocessSnapshot(node, after.childrenOf);
    const previousSnapshot = buildPreprocessSnapshot(
      previous,
      before.childrenOf,
    );
    const profile = getProfile('frame');
    if (
      profile?.watchFields.some(
        (field) => !same(previousSnapshot[field], snapshot[field]),
      )
    )
      candidates.push({ node, snapshot, previousSnapshot });
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
 * A body counts only in the save that says the editor was left
 * (`editingEnded`): a page saves an authored body as it is typed, and a
 * title derived from each intermediate body renamed the file again and
 * again. That save may itself change nothing, the body having been saved
 * already, so it selects the node whatever it carries, and with no
 * "before": the pipeline derives the title from the body as stored.
 *
 * A title that ends up automatic is not an input either: it is what
 * preprocessing produced, saved back.
 */
export function selectAfterContentSave(input: {
  nodeId: string;
  nodeType: string;
  before: Parameters<typeof recordSnapshot>[0];
  after: Parameters<typeof recordSnapshot>[0];
  editingEnded?: boolean;
}): {
  /** The saved node, when its own input changed. */
  node?: Omit<PreprocessCandidate, 'node'>;
  /** Whether a Frame holding the node reads a different child title now. */
  titleChanged: boolean;
} {
  const previousSnapshot = recordSnapshot(input.before);
  const snapshot = recordSnapshot(input.after);
  if (input.editingEnded && SETTLED_BY_EDITOR.has(input.nodeType))
    return {
      node: { snapshot },
      titleChanged: !same(previousSnapshot.title, snapshot.title),
    };
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
