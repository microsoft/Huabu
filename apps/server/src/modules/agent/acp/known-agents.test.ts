// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
      {
        id: 'hermes',
        displayName: 'Hermes Agent',
        binary: 'hermes',
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

  it('defines official argument-based auto-approval recipes', () => {
    expect(
      Object.fromEntries(
        KNOWN_CLIS.map(({ id, autoApprove }) => [id, autoApprove]),
      ),
    ).toEqual({
      copilot: {
        args: ['--allow-all'],
        position: 'after-acp',
      },
      claude: null,
      gemini: {
        args: ['--approval-mode=yolo'],
        position: 'after-acp',
      },
      codex: null,
      qwen: {
        args: ['--approval-mode=yolo'],
        position: 'after-acp',
      },
      kimi: {
        args: ['--yolo'],
        position: 'before-acp',
      },
      opencode: null,
      cursor: {
        args: ['--yolo'],
        position: 'before-acp',
      },
      hermes: null,
    });

    expect(
      Object.fromEntries(
        KNOWN_CLIS.filter((cli) => cli.autoApprove).map((cli) => {
          const approval = cli.autoApprove;
          if (!approval) throw new Error(`Missing recipe for ${cli.id}`);
          const args =
            approval.position === 'before-acp'
              ? [...approval.args, ...cli.acpArgs]
              : [...cli.acpArgs, ...approval.args];
          return [cli.id, [cli.binary, ...args].join(' ')];
        }),
      ),
    ).toEqual({
      copilot: 'copilot --acp --allow-all',
      gemini: 'gemini --acp --approval-mode=yolo',
      qwen: 'qwen --acp --approval-mode=yolo',
      kimi: 'kimi --yolo acp',
      cursor: 'agent --yolo acp',
    });
  });
});
