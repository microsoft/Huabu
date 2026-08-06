// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export type { NestableNode } from './tree.js';
export {
  createAbsolutePositionGetter,
  getAbsolutePosition,
  getDescendantIds,
  indexById,
  normalizeTreeOrder,
} from './tree.js';

export { canParentNode, isContainerNode } from './policy.js';
export {
  moveNodeIntoContainer,
  moveNodeOutOfContainer,
  syncInheritedContainerLocks,
} from './mutation.js';

export type {
  ContainerFitResult,
  ContainerInsets,
  FitContainerOptions,
} from './fit.js';
export { applyContainerFit, computeContainerFit } from './fit.js';

export { assignNodeZIndices, edgeZIndex } from './zorder.js';
