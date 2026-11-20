// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { NodeContentQueue } from '../nodeContentQueue';

/**
 * The content fields of `nodeId` the queue holds as this page's own unsaved
 * change, sorted. `src` and `labelSource` are left out: they are held with
 * `content` (during a conflict) and `label`, and are not what these tests
 * are about.
 */
export function unsavedFields(
  queue: NodeContentQueue,
  nodeId: string,
): string[] {
  return [
    'content',
    'keywords',
    'label',
    'properties',
    'propertyDisplayKeys',
    'provenance',
    'summary',
  ].filter((field) => queue.holdsUnit(nodeId, `data.${field}`));
}
