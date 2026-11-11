// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

interface NoteLinkNode {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
  parentId?: string | null;
  hidden?: boolean;
  selected?: boolean;
}

export function pdfNoteId(node: {
  type?: string;
  data?: Record<string, unknown>;
}): string | undefined {
  return node.type === 'pdf' && typeof node.data?.noteNodeId === 'string'
    ? node.data.noteNodeId
    : undefined;
}

export function pdfNoteIds(
  nodes: readonly { type?: string; data?: Record<string, unknown> }[],
): Set<string> {
  return new Set(
    nodes.flatMap((node) => {
      const id = pdfNoteId(node);
      return id ? [id] : [];
    }),
  );
}

export function includePdfNotes(
  nodes: readonly NoteLinkNode[],
  ids: ReadonlySet<string>,
): Set<string> {
  const result = new Set(ids);
  for (const node of nodes) {
    const id = pdfNoteId(node);
    if (node.id && ids.has(node.id) && id) result.add(id);
  }
  return result;
}

/** Owned notes remain real nodes, but never participate in canvas interaction. */
export function hidePdfNotes<T extends NoteLinkNode>(nodes: T[]): T[] {
  const ids = pdfNoteIds(nodes);
  return nodes.map((node) =>
    node.id &&
    ids.has(node.id) &&
    (!node.hidden || node.selected || node.parentId)
      ? { ...node, hidden: true, selected: false, parentId: undefined }
      : node,
  );
}

export function validPdfNoteLink(
  node: NoteLinkNode,
  value: unknown,
  nodes: readonly NoteLinkNode[],
): boolean {
  if (value === undefined) return pdfNoteId(node) === undefined;
  return (
    node.type === 'pdf' &&
    typeof value === 'string' &&
    nodes.some(
      (candidate) =>
        candidate.id === value &&
        candidate.type === 'note' &&
        !candidate.parentId,
    ) &&
    !nodes.some(
      (candidate) => candidate.id !== node.id && pdfNoteId(candidate) === value,
    ) &&
    (pdfNoteId(node) === undefined || pdfNoteId(node) === value)
  );
}

/** New ownership requires a new Note; existing pairs cannot be replaced or orphaned. */
export function hasValidPdfNoteOwnership(
  nodes: readonly NoteLinkNode[],
  previousNodes: readonly NoteLinkNode[],
): boolean {
  if (
    nodes.some((node) => !validPdfNoteLink(node, node.data?.noteNodeId, nodes))
  )
    return false;
  const previousById = new Map(previousNodes.map((node) => [node.id, node]));
  if (
    nodes.some((node) => {
      const id = pdfNoteId(node);
      const previous = previousById.get(node.id);
      return (
        id && previousById.has(id) && (!previous || pdfNoteId(previous) !== id)
      );
    })
  )
    return false;
  const nextById = new Map(nodes.map((node) => [node.id, node]));
  return previousNodes.every((previous) => {
    const oldId = pdfNoteId(previous);
    if (!oldId) return true;
    const next = nextById.get(previous.id);
    const nextId = next && pdfNoteId(next);
    if (nextId === oldId) return true;
    return !nextId && !nextById.has(oldId);
  });
}
