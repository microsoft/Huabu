// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { renderExternalAgentSystemPreamble } from './system-preamble.js';

describe('external-agent bootstrap routing', () => {
  it('defaults to a direct CLI attempt and hands off to the loaded guide', () => {
    const preamble = renderExternalAgentSystemPreamble();
    expect(preamble).toContain('node "$HUABU_RFS_ENTRY" get-skill');
    expect(preamble).toContain('node "$env:HUABU_RFS_ENTRY" get-skill');
    expect(preamble).toContain('live Space Skill Frames');
    expect(preamble).toContain('Use the CLI by default');
    expect(preamble).toContain('without a separate Node version check');
    expect(preamble).toContain('Add `--output <file>`');
    expect(preamble).toContain(
      'read the saved file with your file-reading tool',
    );
    expect(preamble).toContain(
      'Once the guide loads, follow it and use the CLI for Space operations',
    );
    expect(preamble.indexOf('node "$HUABU_RFS_ENTRY" get-skill')).toBeLessThan(
      preamble.indexOf('curl -fsS'),
    );
  });

  it('limits fallback to unavailable CLI startup without runtime provisioning or anonymous access', () => {
    const preamble = renderExternalAgentSystemPreamble();
    expect(preamble).toContain('If the entry is unset or the CLI cannot start');
    expect(preamble).toContain('report the reason');
    expect(preamble).toContain(
      'Do not guess entry paths or install or upgrade Node',
    );
    expect(preamble).toContain('AUTH="Authorization: Bearer $HUABU_RFS_TOKEN"');
    expect(preamble).toContain('curl -fsS -H "$AUTH" "$HUABU_RFS_URL/skill"');
    expect(preamble).not.toContain('curl -fsS "$HUABU_RFS_URL/skill"');
  });
});
