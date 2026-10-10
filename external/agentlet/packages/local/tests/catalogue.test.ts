import { describe, expect, it } from 'vitest'
import { HARNESS_DEFINITIONS } from '../src/harnesses/registry.js'
import { compileHarnessLaunch } from '../src/harnesses/harness.js'

describe('harness definitions', () => {
  it('exposes the supported agents in stable UI order', () => {
    expect(HARNESS_DEFINITIONS.map(({ id, displayName }) => ({ id, displayName }))).toEqual([
      { id: 'copilot', displayName: 'GitHub Copilot' },
      { id: 'claude', displayName: 'Claude Agent' },
      { id: 'gemini', displayName: 'Gemini' },
      { id: 'codex', displayName: 'Codex' },
      { id: 'qwen', displayName: 'Qwen Code' },
      { id: 'kimi', displayName: 'Kimi Code' },
      { id: 'opencode', displayName: 'OpenCode' },
      { id: 'cursor', displayName: 'Cursor' },
      { id: 'codebuddy', displayName: 'CodeBuddy' },
      { id: 'hermes', displayName: 'Hermes Agent' },
      { id: 'custom', displayName: 'Custom command' },
    ])
  })

  it('compiles trusted terminal-style commands', () => {
    expect(compileHarnessLaunch({
      kind: 'acp-harness',
      harnessId: 'copilot',
      options: { autoApprove: true },
    })).toEqual({ kind: 'shell', command: 'copilot --acp --allow-all' })
    expect(compileHarnessLaunch({
      kind: 'acp-harness',
      harnessId: 'kimi',
      options: { autoApprove: true },
    })).toEqual({ kind: 'shell', command: 'kimi --yolo acp' })
    expect(compileHarnessLaunch({
      kind: 'acp-harness',
      harnessId: 'claude',
    })).toEqual({ kind: 'shell', command: 'claude-agent-acp' })
  })
})
