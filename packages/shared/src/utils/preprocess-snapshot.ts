// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What a preprocessing request carries for one node: the fields the server
 * pipeline reads. It is the one definition of "preprocessing input" — the
 * server compares it before and after a write to decide whether a node needs
 * processing, and a page sends it with the requests only a page can decide
 * (an editor that was left, a title that is empty on load).
 */

interface SnapshotNode {
  id: string;
  type?: string;
  data?: unknown;
}

/**
 * @param getChildNodes Direct children of a Frame; a Frame's input is its
 *   children's titles.
 */
export function buildPreprocessSnapshot<T extends SnapshotNode>(
  node: T,
  getChildNodes: (frameId: string) => readonly T[],
): Record<string, unknown> {
  const data = node.data as Record<string, unknown> | undefined;
  const nodeType = node.type ?? '';

  if (nodeType === 'frame') {
    const childLabels = getChildNodes(node.id)
      .map((child) => {
        const childData = child.data as Record<string, unknown> | undefined;
        return typeof childData?.label === 'string'
          ? childData.label.trim()
          : '';
      })
      .filter((label) => label.length > 0);
    return {
      title: (data?.label as string) || undefined,
      childLabels,
      labelSource: (data?.labelSource as string) || undefined,
    };
  }

  if (nodeType === 'question') {
    // Question prompts live at `data.content` just like text / note bodies.
    const content =
      typeof data?.content === 'string' ? data.content.trim() : '';
    return {
      title: (data?.label as string) || (data?.title as string) || undefined,
      labelSource: (data?.labelSource as string) || undefined,
      content: content || undefined,
    };
  }

  return {
    title: (data?.label as string) || (data?.title as string) || undefined,
    labelSource: (data?.labelSource as string) || undefined,
    content: (data?.content as string) || undefined,
    src: (data?.src as string) || undefined,
  };
}
