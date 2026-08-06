// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { evaluateAssertions } from './assertions.js';

import type { Trace } from './trace.js';

function traceWithTool(name: string, ok: boolean): Trace {
  return {
    schemaVersion: 1,
    caseId: 'space-tool-name',
    seed: 0,
    startedAt: '2026-07-14T00:00:00.000Z',
    elapsedMs: 1,
    turns: 1,
    toolCalls: [
      {
        name,
        args: { commands: [] },
        ms: 1,
        ok,
        resultPreview: '',
      },
    ],
    finalText: '',
    error: null,
    stopReason: 'stop',
    usage: null,
  };
}

describe('Space tool assertions', () => {
  it('accepts a successful space_commands call', () => {
    const results = evaluateAssertions(traceWithTool('space_commands', true), [
      { kind: 'tool_called', name: 'space_commands' },
      { kind: 'tool_succeeded', name: 'space_commands' },
    ]);

    expect(results).toEqual([
      { id: 'tool_called:space_commands', pass: true },
      { id: 'tool_succeeded:space_commands', pass: true },
    ]);
  });

  it('does not hide a regression to the legacy canvas_commands name', () => {
    const [result] = evaluateAssertions(
      traceWithTool('canvas_commands', true),
      [{ kind: 'tool_called', name: 'space_commands' }],
    );

    expect(result).toMatchObject({
      id: 'tool_called:space_commands',
      pass: false,
    });
  });
});
