// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Normalize label fallback.
 *
 * A `question` node has no Extract stage, so when the LLM enrich stage produces
 * nothing (offline / provider unreachable) the node would otherwise be left
 * nameless. Normalize derives a stable local title from the first line so the
 * node always has a name; the LLM label only applies when enrichment succeeds.
 */

import { describe, expect, it } from 'vitest';

import { normalize } from './normalize.js';

import type { ResolvedInput, ExtractResult } from '../types.js';

const skipped: ExtractResult = { skipped: true };

describe('normalize — local title fallback', () => {
  it('derives a question label from the first content line when no title exists', () => {
    const resolved: ResolvedInput = {
      nodeId: 'n1',
      nodeType: 'question',
      content: 'How does the retry backfill work?\nsecond line',
    };
    expect(normalize(resolved, skipped).label).toBe(
      'How does the retry backfill work?',
    );
  });

  it('prefers a markdown heading over the first line', () => {
    const resolved: ResolvedInput = {
      nodeId: 'n2',
      nodeType: 'question',
      content: 'intro\n# The Real Title\nbody',
    };
    expect(normalize(resolved, skipped).label).toBe('The Real Title');
  });

  it('leaves an empty-content node without a label', () => {
    const resolved: ResolvedInput = {
      nodeId: 'n3',
      nodeType: 'question',
      content: '   ',
    };
    expect(normalize(resolved, skipped).label).toBeUndefined();
  });

  it('does not override a user-owned title', () => {
    const resolved: ResolvedInput = {
      nodeId: 'n4',
      nodeType: 'question',
      content: 'first line of the question',
      title: 'My Node',
      labelSource: 'user',
    };
    expect(normalize(resolved, skipped).label).toBe('My Node');
  });
});
