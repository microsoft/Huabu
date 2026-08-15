// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  isCoveredCanvasVersionConflict,
  reconcileCanvasVersion,
} from '../structureSaveReconciliation';

describe('structure save version reconciliation', () => {
  it('does not let a delayed save acknowledgement roll back an SSE version', () => {
    expect(reconcileCanvasVersion(12, 11, null)).toEqual({
      version: 12,
      conflictResolved: false,
    });
  });

  it('treats a delayed 409 as covered after SSE reaches its server version', () => {
    expect(isCoveredCanvasVersionConflict(12, 12)).toBe(true);
    expect(isCoveredCanvasVersionConflict(13, 12)).toBe(true);
    expect(isCoveredCanvasVersionConflict(11, 12)).toBe(false);
  });

  it('resolves a latched conflict when a later SSE update catches up', () => {
    expect(reconcileCanvasVersion(11, 12, 12)).toEqual({
      version: 12,
      conflictResolved: true,
    });
  });
});
