// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { isArtifactsRel, toPhysicalRel } from './fs-sandbox.js';

/**
 * `isArtifactsRel` applies the segment-aware membership rules after a node
 * `src` has been safely resolved relative to its actual Space. The import-hook
 * tests cover that filesystem resolution; these pure cases pin the remaining
 * path classification without a fixture.
 */
describe('isArtifactsRel', () => {
  it('accepts both the virtual and physical spellings', () => {
    expect(isArtifactsRel(toPhysicalRel('artifacts/pic.png'))).toBe(true);
    expect(isArtifactsRel(toPhysicalRel('.artifacts/pic.png'))).toBe(true);
    // A bare key resolves into the artifacts dir via the same map.
    expect(isArtifactsRel(toPhysicalRel('artifacts'))).toBe(true);
  });

  it('rejects refs outside the artifacts directory', () => {
    expect(isArtifactsRel(toPhysicalRel('nodes/foo.md'))).toBe(false);
    expect(isArtifactsRel(toPhysicalRel('upload/pic.png'))).toBe(false);
    expect(isArtifactsRel(toPhysicalRel('space.json'))).toBe(false);
    // A sibling whose name merely starts with the directory name is not
    // inside it — the reason this is a segment-wise test, not a prefix one.
    expect(isArtifactsRel(toPhysicalRel('.artifacts-evil/pic.png'))).toBe(
      false,
    );
  });

  it('collapses traversal rather than matching on the literal prefix', () => {
    // Reaches the hidden dir the long way round; a bare prefix test would
    // miss it and the hook would import a file that is already stored.
    expect(isArtifactsRel(toPhysicalRel('nodes/../.artifacts/pic.png'))).toBe(
      true,
    );
    // Leaves it again, so it is an ordinary local file.
    expect(isArtifactsRel(toPhysicalRel('.artifacts/../nodes/foo.md'))).toBe(
      false,
    );
  });

  it('aliases the virtual prefix only at the start of the ref', () => {
    // `toPhysicalRel` rewrites `artifacts/` as a prefix, so a mid-path
    // occurrence stays literal and resolves to `/artifacts/…`, which is not
    // the hidden directory. Pinned because it is a limitation, not a
    // decision: the pre-existing check behaved the same way, and widening it
    // would change which files the import hook copies.
    expect(isArtifactsRel(toPhysicalRel('nodes/../artifacts/pic.png'))).toBe(
      false,
    );
  });
});
