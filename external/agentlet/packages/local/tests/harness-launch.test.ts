import { describe, expect, it } from 'vitest'
import { parseAcpHarnessLaunch, CUSTOM_COMMAND_WRAPPER_ID, CUSTOM_COMMAND_CAPABILITIES } from '@agentlet/protocol'
import { KNOWN_CLIS } from '../src/harnesses/catalogue.js'
import { Harness, buildHarnessLaunch, resolveHarnessLaunch } from '../src/harnesses/harness.js'

describe('typed ACP harness launch', () => {
  it.each(KNOWN_CLIS)('retains the existing $id ACP preset exactly', (entry) => {
    const harness = Harness.get(entry.id)
    expect(harness.buildLaunch()).toEqual({
      kind: 'exec', executable: entry.binary, argv: entry.acpArgs, env: {},
    })
    expect(harness.describeCapabilities()).toEqual({
      autoApprove: entry.autoApprove ? 'supported' : 'unsupported',
      modelOverride: 'unknown',
      sessionPersistence: 'unknown',
      customLaunchCommand: 'unsupported',
    })
    expect(harness.buildLaunch({ autoApprove: false })).toEqual(harness.buildLaunch())
    if (entry.autoApprove) {
      const built = harness.buildLaunch({ autoApprove: true })
      expect(built.kind === 'exec' && built.argv).toEqual(
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
    const built = Harness.get('copilot').buildLaunch({ autoApprove: true })
    if (built.kind === 'exec') built.argv.push('--untrusted')
    const next = Harness.get('copilot').buildLaunch({ autoApprove: true })
    expect(next.kind === 'exec' && next.argv)
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
    expect(() => Harness.get('not-known')).toThrow('Unknown harness')
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

  it('maps legacy commands only to custom without inferring a known wrapper', async () => {
    const custom = Harness.get(CUSTOM_COMMAND_WRAPPER_ID)
    expect(custom.describeCapabilities()).toEqual(CUSTOM_COMMAND_CAPABILITIES)
    expect(Object.isFrozen(CUSTOM_COMMAND_CAPABILITIES)).toBe(true)
    expect(custom.describeCapabilities()).toEqual({
      customLaunchCommand: 'supported', autoApprove: 'unsupported',
      modelOverride: 'unsupported', sessionPersistence: 'unsupported',
    })
    expect(await custom.detect({ prepareWorkspaces: true })).toMatchObject({
      id: 'custom', installed: false, launchPreviewVersion: 1,
    })
    expect(buildHarnessLaunch({ launch: { kind: 'acp-command', command: 'copilot --acp && echo trusted' } }))
      .toEqual({ kind: 'shell', command: 'copilot --acp && echo trusted' })
    for (const intent of [{ autoApprove: false }, { model: 'model' }, { sessionPersistence: false }]) {
      expect(() => custom.buildLaunch({ customLaunchCommand: 'agent', ...intent })).toThrow()
    }
    expect(() => Harness.get('copilot').buildLaunch({ customLaunchCommand: 'agent' })).toThrow()
    expect(() => buildHarnessLaunch({ launch: { kind: 'acp-harness', harnessId: 'custom' } })).toThrow()
    expect(() => buildHarnessLaunch({ launch: { kind: 'acp-command', command: ' ' } })).toThrow()
    expect(() => buildHarnessLaunch({ launch: { kind: 'acp-command', command: 'agent', options: { autoApprove: true } } })).toThrow()
    expect(buildHarnessLaunch({ launch: { kind: 'acp-harness', harnessId: 'copilot', options: { autoApprove: true } } }))
      .toEqual({ kind: 'exec', executable: 'copilot', argv: ['--acp', '--allow-all'], env: {} })
  })
})
