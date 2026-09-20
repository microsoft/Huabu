import { describe, expect, it } from 'vitest'
import { parseAcpHarnessLaunch } from '@agentlet/protocol'
import { KNOWN_CLIS } from '../src/harnesses/catalogue.js'
import { Harness, resolveHarnessLaunch } from '../src/harnesses/harness.js'

describe('typed ACP harness launch', () => {
  it.each(KNOWN_CLIS)('retains the existing $id ACP preset exactly', (entry) => {
    const harness = Harness.get(entry.id)
    expect(harness.buildLaunch()).toEqual({
      version: 1, executable: entry.binary, argv: entry.acpArgs, env: {},
    })
    expect(harness.describeCapabilities()).toEqual({
      autoApprove: entry.autoApprove ? 'supported' : 'unsupported',
      modelOverride: 'unknown',
      sessionPersistence: 'unknown',
    })
    expect(harness.buildLaunch({ autoApprove: false })).toEqual(harness.buildLaunch())
    if (entry.autoApprove) {
      expect(harness.buildLaunch({ autoApprove: true }).argv).toEqual(
        entry.autoApprove.position === 'before-acp'
          ? [...entry.autoApprove.args, ...entry.acpArgs]
          : [...entry.acpArgs, ...entry.autoApprove.args],
      )
    } else {
      expect(() => harness.buildLaunch({ autoApprove: true })).toThrow('does not support')
    }
  })

  it('defers model intent to ACP without native flags or shell interpretation', () => {
    const model = 'custom model; $(not-a-command) "quoted"'
    for (const id of ['claude', 'codex', 'copilot']) {
      const harness = Harness.get(id)
      expect(harness.buildLaunch({ model })).toEqual({
        ...harness.buildLaunch(),
        initialPreferences: { model },
      })
    }
    expect(Harness.get('claude').buildLaunch()).toMatchObject({
      executable: 'claude-agent-acp', argv: [],
    })
  })

  it('does not expose mutable catalogue arrays', () => {
    Harness.get('copilot').buildLaunch({ autoApprove: true }).argv.push('--untrusted')
    expect(Harness.get('copilot').buildLaunch({ autoApprove: true }).argv)
      .toEqual(['--acp', '--allow-all'])
  })

  it.each([
    { kind: 'acp-harness', harnessId: '../copilot' },
    { kind: 'native-print', harnessId: 'copilot' },
    { kind: 'acp-harness', harnessId: 'copilot', executable: 'other' },
    { kind: 'acp-harness', harnessId: 'copilot', options: { argv: ['--other'] } },
    { kind: 'acp-harness', harnessId: 'copilot', options: { model: 'not-a-launch-flag' } },
    { kind: 'acp-harness', harnessId: 'claude', options: { noSave: true } },
    { kind: 'acp-harness', harnessId: 'copilot', options: { autoApprove: 'true' } },
  ])('rejects unsupported or malformed structured input %j', (launch) => {
    expect(() => parseAcpHarnessLaunch(launch)).toThrow()
  })

  it('validates identity locally and rejects altered persisted plans instead of executing them', () => {
    expect(() => Harness.get('custom')).toThrow('Unknown harness')
    const launch = { kind: 'acp-harness', harnessId: 'copilot', options: { autoApprove: true } }
    const plan = resolveHarnessLaunch(launch)
    expect(resolveHarnessLaunch(launch, plan)).toEqual(plan)
    for (const changed of [
      { ...plan, executable: 'untrusted' },
      { ...plan, argv: [...plan.argv, 'a; echo injected'] },
      { ...plan, env: { UNTRUSTED: 'value' } },
    ]) {
      expect(() => resolveHarnessLaunch(launch, changed)).toThrow('reauthorization')
    }
    expect(() => resolveHarnessLaunch({ ...launch, options: {} }, plan)).toThrow('reauthorization')
  })
})
