// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { Node } from '@xyflow/react';

/**
 * Return whether a node may own persistent children.
 *
 * Frames are the persistent Container type.
 */
export function isContainerNode(node: Pick<Node, 'type'> | undefined): boolean {
  return node?.type === 'frame';
}

/** Return whether `child` may be parented by `parent`. */
export function canParentNode(
  parent: Node | undefined,
  child: Node | undefined,
): boolean {
  return (
    !!parent && !!child && parent.id !== child.id && isContainerNode(parent)
  );
}
