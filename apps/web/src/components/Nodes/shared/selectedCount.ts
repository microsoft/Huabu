// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Share one scan per immutable node array across node consumers.
let previousNodes: readonly { selected?: boolean }[] | null = null;
let previousCount = 0;

export function selectSelectedCount(
  nodes: readonly { selected?: boolean }[],
): number {
  if (nodes !== previousNodes) {
    previousNodes = nodes;
    previousCount = 0;
    for (const node of nodes) if (node.selected) previousCount++;
  }
  return previousCount;
}
