import { describe, expect, it } from 'vitest';

import { KNOWN_CLIS } from './known-agents.js';

describe('KNOWN_CLIS', () => {
  it('exposes the supported agents in UI order with their ACP commands', () => {
    expect(
      KNOWN_CLIS.map(({ id, displayName, binary, acpArgs }) => ({
        id,
        displayName,
        binary,
        acpArgs,
      })),
    ).toEqual([
      {
        id: 'copilot',
        displayName: 'GitHub Copilot',
        binary: 'copilot',
        acpArgs: ['--acp'],
      },
      {
        id: 'claude',
        displayName: 'Claude Agent',
        binary: 'claude-agent-acp',
        acpArgs: [],
      },
      {
        id: 'gemini',
        displayName: 'Gemini',
        binary: 'gemini',
        acpArgs: ['--acp'],
      },
      {
        id: 'codex',
        displayName: 'Codex',
        binary: 'codex-acp',
        acpArgs: [],
      },
      {
        id: 'qwen',
        displayName: 'Qwen Code',
        binary: 'qwen',
        acpArgs: ['--acp'],
      },
      {
        id: 'kimi',
        displayName: 'Kimi Code',
        binary: 'kimi',
        acpArgs: ['acp'],
      },
      {
        id: 'opencode',
        displayName: 'OpenCode',
        binary: 'opencode',
        acpArgs: ['acp'],
      },
      {
        id: 'cursor',
        displayName: 'Cursor',
        binary: 'agent',
        acpArgs: ['acp'],
      },
    ]);
  });

  it('uses unique ids and binary names', () => {
    expect(new Set(KNOWN_CLIS.map((cli) => cli.id)).size).toBe(
      KNOWN_CLIS.length,
    );
    expect(new Set(KNOWN_CLIS.map((cli) => cli.binary)).size).toBe(
      KNOWN_CLIS.length,
    );
  });
});
