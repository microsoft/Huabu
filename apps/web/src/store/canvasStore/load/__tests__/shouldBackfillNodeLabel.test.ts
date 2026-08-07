// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { shouldBackfillNodeLabel } from '../shouldBackfillNodeLabel';

import type { Node } from '@xyflow/react';

function node(data: Record<string, unknown>): Node {
  return {
    id: 'node-1',
    type: 'note',
    position: { x: 0, y: 0 },
    data,
  };
}

describe('shouldBackfillNodeLabel', () => {
  it('repairs a legacy node with an empty label', () => {
    expect(shouldBackfillNodeLabel(node({ label: '' }))).toBe(true);
  });

  it('does not recreate a missing markdown sidecar', () => {
    expect(
      shouldBackfillNodeLabel(node({ contentMissing: true, label: '' })),
    ).toBe(false);
  });

  it('leaves an existing label alone', () => {
    expect(shouldBackfillNodeLabel(node({ label: 'Existing' }))).toBe(false);
  });
});
