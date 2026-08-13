// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for the `{{include:<rel>}}` template directive on `renderTemplate`.
 *
 * `renderTemplate` is not exported (intentionally — its only public
 * entry point is `loadAgent`), so we exercise it indirectly through
 * the `messageTemplates` channel: each test plants a transient
 * `messageTemplates.body` entry on the cached `LoadedAgent` and asks
 * `renderAgentTemplate` to render it. This lets us drive include
 * resolution end-to-end (including the load-time file read, traversal
 * guard, and nested-include detection) without spinning up a fresh
 * AGENT.md per case.
 *
 * Variable substitution and conditional blocks are NOT re-tested here
 * — they were stable before this change and are covered by the wider
 * agent suite.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  invalidateAgentCache,
  loadAgent,
  renderAgentTemplate,
  AGENTS_DIR,
} from './agents/loader.js';

const PROMPT_ROOT = path.dirname(AGENTS_DIR);

function renderBody(body: string): string {
  const agent = loadAgent('ask');
  // Splice a one-shot template onto the cached agent so we can drive
  // renderTemplate through the public API. The cache is invalidated in
  // afterEach so the mutation never leaks across tests.
  (agent.messageTemplates as Record<string, string>).body = body;
  return renderAgentTemplate(agent, 'body');
}

describe('renderTemplate {{include}}', () => {
  afterEach(() => {
    invalidateAgentCache();
  });

  it('inlines the contents of a prompt-root-relative file', () => {
    // canvas SKILL is the motivating use case — keep this assertion
    // anchored to its real content so an accidental SKILL rewrite is
    // caught by this test, not by silent runtime breakage.
    const out = renderBody('# Header\n\n{{include:skills/space/SKILL.md}}');
    expect(out).toContain('# Header');
    expect(out).toContain('# Space');
    expect(out).toContain('## Tool decision matrix');
  });

  it('inlines the canonical node-sizing policy', () => {
    const out = renderBody(
      '{{include:skills/space/references/layout-recipes.md}}',
    );

    expect(out).toContain('nearNode: { id: "<anchorId>"');
    expect(out).toContain('omit `size`');
    expect(out).toContain('Reserve `height: "auto"` for short Notes');
  });

  it('throws when the included path escapes PROMPT_ROOT', () => {
    expect(() => renderBody('{{include:../../etc/passwd}}')).toThrow(
      /escapes the prompt root/,
    );
  });

  it('throws when the included path is absolute', () => {
    expect(() => renderBody('{{include:/etc/passwd}}')).toThrow(
      /must be PROMPT-ROOT relative/,
    );
  });

  it('throws when the included file does not exist', () => {
    expect(() =>
      renderBody('{{include:skills/does-not-exist/SKILL.md}}'),
    ).toThrow(/file not found/);
  });

  it('throws when the include path is empty', () => {
    expect(() => renderBody('{{include: }}')).toThrow(/non-empty path/);
  });
});

describe('renderTemplate {{include}} (nested includes forbidden)', () => {
  // The nested-include guard reads disk, so we stand up a throwaway
  // SKILL file under `skills/` (the only place an include can reach)
  // that itself contains another `{{include:…}}`. The whole scratch
  // dir is wiped in afterEach.
  const scratchDir = path.join(PROMPT_ROOT, 'skills', '__test_nested');
  const scratchRel = 'skills/__test_nested/INNER.md';

  beforeEach(() => {
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(
      path.join(PROMPT_ROOT, scratchRel),
      '# Inner\n\n{{include:skills/space/SKILL.md}}\n',
      'utf8',
    );
  });

  afterEach(() => {
    invalidateAgentCache();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('throws when an included file itself contains {{include:...}}', () => {
    expect(() => renderBody(`{{include:${scratchRel}}}`)).toThrow(
      /nested includes are not supported/,
    );
  });
});
