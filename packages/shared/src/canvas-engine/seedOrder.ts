// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Order keys for a Space stored before nodes carried them.
 *
 * Such a Space holds order as array position. Reading it gives every node
 * the key its position stands for. The result depends only on the stored
 * state, so two reads before the first write agree, and the keys are stored
 * with the Space's next write. A Space that already has its keys comes back
 * unchanged, array included.
 */

import { settlePaintOrder } from './container/paintOrder.js';

import type { NestableNode } from './container/tree.js';

export function seedNodeOrder<T extends NestableNode>(
  nodes: readonly T[],
): T[] {
  return settlePaintOrder(nodes);
}
