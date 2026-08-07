/**
 * Tests for `parseFrontmatter` line-ending handling.
 *
 * The full YAML parsing surface is exercised indirectly by the node /
 * agent / skill loader suites; these tests focus on the CRLF
 * normalisation path that was added to keep Windows-authored
 * frontmatter from leaking trailing `\r` characters into scalar
 * values (which used to break enum-style validators like
 * `runtime.toolExecution`).
 */

import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from './markdown-frontmatter.js';

describe('parseFrontmatter line-ending normalisation', () => {
  it('parses LF frontmatter into native scalar types', () => {
    const { meta, content } = parseFrontmatter(
      '---\nname: alice\ncount: 6\n---\nbody\n',
    );
    expect(meta).toEqual({ name: 'alice', count: 6 });
    expect(content).toBe('body\n');
  });

  it('strips trailing \\r from CRLF-authored values', () => {
    // Regression: before normalisation `count` came back as the
    // string "6\r" because `yaml.parse` treated the bare `\r` left
    // by the slice boundary as part of the scalar. After the fix
    // both string and number scalars round-trip cleanly.
    const { meta } = parseFrontmatter(
      '---\r\nname: alice\r\ncount: 6\r\n---\r\nbody\r\n',
    );
    expect(meta).toEqual({ name: 'alice', count: 6 });
  });

  it('handles nested objects authored with CRLF endings', () => {
    // The original failure mode that motivated this fix: a nested
    // enum-typed field (`runtime.toolExecution`) in a Windows-
    // authored AGENT.md was rejected by the loader's allowlist
    // because the value parsed as `"parallel\r"`.
    const { meta } = parseFrontmatter(
      '---\r\nid: demo\r\nruntime:\r\n  maxIterations: 6\r\n  toolExecution: parallel\r\n---\r\nbody',
    );
    expect(meta).toEqual({
      id: 'demo',
      runtime: { maxIterations: 6, toolExecution: 'parallel' },
    });
  });
});
