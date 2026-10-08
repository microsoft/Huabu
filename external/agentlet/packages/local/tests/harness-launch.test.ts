import { describe, expect, it } from 'vitest'
import { parseAcpHarnessLaunch } from '@agentlet/protocol'
import { compileHarnessLaunch } from '../src/harnesses/harness.js'

describe('typed ACP harness launch', () => {
  it('compiles known and Custom launch intent through the shell boundary', () => {
    expect(compileHarnessLaunch({
      kind: 'acp-harness',
      harnessId: 'copilot',
      options: { autoApprove: true },
    })).toEqual({ kind: 'shell', command: 'copilot --acp --allow-all' })
    expect(compileHarnessLaunch({
      kind: 'acp-command',
      command: 'copilot --acp && echo explicitly-authorized',
    })).toEqual({
      kind: 'shell',
      command: 'copilot --acp && echo explicitly-authorized',
    })
  })

  it('validates but ignores legacy persisted plans', () => {
    const launch = {
      kind: 'acp-harness',
      harnessId: 'copilot',
      options: { autoApprove: true },
    }
    const plan = {
      version: 1 as const,
      executable: 'old-copilot',
      argv: ['--old'],
      env: { OLD: 'value' },
    }
    expect(compileHarnessLaunch(launch, plan)).toEqual({
      kind: 'shell',
      command: 'copilot --acp --allow-all',
    })
    expect(() => compileHarnessLaunch(launch, {
      ...plan,
      version: 2 as never,
    })).toThrow('Invalid legacy')
  })

  it.each([
    { kind: 'acp-harness', harnessId: '../copilot' },
    { kind: 'native-print', harnessId: 'copilot' },
    { kind: 'acp-harness', harnessId: 'copilot', executable: 'other' },
    { kind: 'acp-harness', harnessId: 'copilot', options: { argv: ['--other'] } },
    { kind: 'acp-harness', harnessId: 'copilot', options: { autoApprove: 'true' } },
  ])('rejects unsupported or malformed structured input %j', (launch) => {
    expect(() => parseAcpHarnessLaunch(launch)).toThrow()
  })

  it('rejects unsupported approval and invalid identities', () => {
    expect(() => compileHarnessLaunch({
      kind: 'acp-harness',
      harnessId: 'claude',
      options: { autoApprove: true },
    })).toThrow('does not support')
    expect(() => compileHarnessLaunch({
      kind: 'acp-harness',
      harnessId: 'custom',
    })).toThrow('explicit ACP command')
    expect(() => compileHarnessLaunch({
      kind: 'acp-harness',
      harnessId: 'unknown',
    })).toThrow('Unknown harness')
  })
})
