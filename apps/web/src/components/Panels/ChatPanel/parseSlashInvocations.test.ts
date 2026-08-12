// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for `parseSlashInvocations`.
 *
 * Pure function — exhaustively cover the leading-token grammar,
 * unknown-token bail-out, dedup, whitespace handling, and the
 * "mid-sentence `/` is literal" rule.
 */

import { describe, expect, it } from 'vitest';

import { parseSlashInvocations } from './parseSlashInvocations';

describe('parseSlashInvocations', () => {
  const known = new Set(['canvas-memory', 'workspace-memory', 'create-skill']);

  it('extracts a single leading token', () => {
    const r = parseSlashInvocations('/canvas-memory help me', known);
    expect(r.invokedSkills).toEqual(['canvas-memory']);
    expect(r.message).toBe('help me');
  });

  it('extracts multiple leading tokens in order', () => {
    const r = parseSlashInvocations(
      '/canvas-memory /workspace-memory now do X',
      known,
    );
    expect(r.invokedSkills).toEqual(['canvas-memory', 'workspace-memory']);
    expect(r.message).toBe('now do X');
  });

  it('dedupes repeated tokens, preserving first-seen order', () => {
    const r = parseSlashInvocations(
      '/canvas-memory /canvas-memory /workspace-memory go',
      known,
    );
    expect(r.invokedSkills).toEqual(['canvas-memory', 'workspace-memory']);
    expect(r.message).toBe('go');
  });

  it('stops at the first unknown token and leaves the rest in the message', () => {
    const r = parseSlashInvocations(
      '/canvas-memory /not-a-skill rest of message',
      known,
    );
    expect(r.invokedSkills).toEqual(['canvas-memory']);
    expect(r.message).toBe('/not-a-skill rest of message');
  });

  it('treats mid-sentence slashes as literal', () => {
    const r = parseSlashInvocations(
      'check src/main.ts and /canvas-memory',
      known,
    );
    expect(r.invokedSkills).toEqual([]);
    expect(r.message).toBe('check src/main.ts and /canvas-memory');
  });

  it('handles only-slash-tokens input (empty message body)', () => {
    const r = parseSlashInvocations('/canvas-memory', known);
    expect(r.invokedSkills).toEqual(['canvas-memory']);
    expect(r.message).toBe('');
  });

  it('strips leading whitespace before parsing', () => {
    const r = parseSlashInvocations('   /canvas-memory hi', known);
    expect(r.invokedSkills).toEqual(['canvas-memory']);
    expect(r.message).toBe('hi');
  });

  it('returns nothing invoked for plain text', () => {
    const r = parseSlashInvocations('just a normal message', known);
    expect(r.invokedSkills).toEqual([]);
    expect(r.message).toBe('just a normal message');
  });

  it('returns empty results for empty input', () => {
    const r = parseSlashInvocations('', known);
    expect(r.invokedSkills).toEqual([]);
    expect(r.message).toBe('');
  });

  it('does not match `/foo/bar` as command `foo`', () => {
    // The trailing `\s+|$` anchor in the token regex makes this a
    // non-match — important so users can paste paths like
    // `/etc/hosts` without triggering false slash-command parsing.
    const r = parseSlashInvocations('/canvas-memory/extra arg', known);
    expect(r.invokedSkills).toEqual([]);
    expect(r.message).toBe('/canvas-memory/extra arg');
  });

  it('respects case sensitivity', () => {
    const r = parseSlashInvocations('/Canvas-Memory hi', known);
    // `Canvas-Memory` is not in `known`, so it is left as literal text.
    expect(r.invokedSkills).toEqual([]);
    expect(r.message).toBe('/Canvas-Memory hi');
  });
});
