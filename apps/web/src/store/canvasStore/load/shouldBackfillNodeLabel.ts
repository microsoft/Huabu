// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { Node } from '@xyflow/react';

/** Return whether load-time preprocessing should repair a legacy empty label. */
export function shouldBackfillNodeLabel(node: Node): boolean {
  const data = node.data as Record<string, unknown> | undefined;
  if (data?.contentMissing === true) return false;
  const label = typeof data?.label === 'string' ? data.label : '';
  return label.trim().length === 0;
}
