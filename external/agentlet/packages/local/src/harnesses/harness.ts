import { isDeepStrictEqual } from 'node:util'
import { parseAcpHarnessLaunch, parseAgentProfileLaunch, parseBuildHarnessLaunchParams, parseHarnessLaunchPreview, CUSTOM_COMMAND_WRAPPER_ID, CUSTOM_COMMAND_CAPABILITIES } from '@agentlet/protocol'
import type { HarnessCapabilities, HarnessLaunchOptions, HarnessLaunchPlan, HarnessLaunchPreview, HarnessDiscoveryParams, HarnessDiscoveryEntry } from '@agentlet/protocol'
import { KNOWN_CLIS, type KnownCli } from './catalogue.js'
import { detectKnownHarness } from './probe.js'

export interface HarnessLaunchIntent {
  autoApprove?: boolean
  customLaunchCommand?: string
  /** ACP preference only; never translated into guessed command-line arguments. */
  model?: string
}

export type HarnessBuiltLaunch = HarnessLaunchPreview & { initialPreferences?: { model: string } }

/** A wrapper selected by launch identity, never editable metadata or command inference. */
export class Harness {
  private constructor(private readonly entry?: KnownCli) {}

  static get(harnessId: string): Harness {
    if (harnessId === CUSTOM_COMMAND_WRAPPER_ID) return new Harness()
    const entry = KNOWN_CLIS.find((candidate) => candidate.id === harnessId)
    if (!entry) throw new Error(`Unknown harness: ${harnessId}`)
    return new Harness(entry)
  }

  static forLaunch(launch: unknown): Harness {
    const parsed = parseAgentProfileLaunch(launch)
    if (parsed.kind === 'acp-harness' && parsed.harnessId === CUSTOM_COMMAND_WRAPPER_ID)
      throw new Error('Custom wrapper requires an explicit ACP command launch')
    return Harness.get(parsed.kind === 'acp-command' ? CUSTOM_COMMAND_WRAPPER_ID : parsed.harnessId)
  }

  async detect(options: HarnessDiscoveryParams = {}): Promise<HarnessDiscoveryEntry> {
    if (this.entry) return {
      ...await detectKnownHarness(this.entry, options),
      capabilities: this.describeCapabilities(),
    }
    return {
      id: CUSTOM_COMMAND_WRAPPER_ID, displayName: 'Custom', binary: CUSTOM_COMMAND_WRAPPER_ID, acpArgs: [],
      autoApprove: null, installHint: 'Provide a trusted ACP command',
      installed: false, launchPreviewVersion: 1, capabilities: this.describeCapabilities(),
    }
  }

  describeCapabilities(): HarnessCapabilities {
    if (!this.entry) return { ...CUSTOM_COMMAND_CAPABILITIES }
    return {
      customLaunchCommand: 'unsupported',
      autoApprove: this.entry.autoApprove ? 'supported' : 'unsupported',
      modelOverride: 'unknown',
      sessionPersistence: 'unknown',
    }
  }

  buildLaunch(intent: HarnessLaunchIntent = {}): HarnessBuiltLaunch {
    if (!this.entry) {
      if (intent === null || typeof intent !== 'object' || Array.isArray(intent) ||
        Object.keys(intent).some((key) => key !== 'customLaunchCommand'))
        throw new Error('Custom wrapper accepts only customLaunchCommand')
      const parsed = parseAgentProfileLaunch({ kind: 'acp-command', command: intent.customLaunchCommand })
      if (parsed.kind !== 'acp-command') throw new Error('Custom wrapper requires a command')
      return { kind: 'shell', command: parsed.command }
    }
    if (intent === null || typeof intent !== 'object' || Array.isArray(intent) ||
      Object.keys(intent).some((key) => !['autoApprove', 'model'].includes(key)) ||
      (intent.model !== undefined && (typeof intent.model !== 'string' ||
        !intent.model.trim() || intent.model.length > 1024 || intent.model.includes('\0')))) {
      throw new Error('Harness launch accepts only autoApprove and a bounded ACP model preference')
    }
    const options: HarnessLaunchOptions = intent.autoApprove === undefined ? {} : { autoApprove: intent.autoApprove }
    parseAcpHarnessLaunch({ kind: 'acp-harness', harnessId: this.entry.id, options })
    const approval = intent.autoApprove ? this.entry.autoApprove : null
    if (intent.autoApprove && !approval) {
      throw new Error(`Harness '${this.entry.id}' does not support launch-time autoApprove`)
    }
    return {
      kind: 'exec',
      executable: this.entry.binary,
      argv: approval?.position === 'before-acp'
        ? [...approval.args, ...this.entry.acpArgs]
        : [...this.entry.acpArgs, ...(approval?.args ?? [])],
      env: {},
      ...(intent.model === undefined ? {} : { initialPreferences: { model: intent.model } }),
    }
  }
}

/** Resolve locally; a caller-supplied plan is only an equality assertion, never executable input. */
export function resolveHarnessLaunch(launch: unknown, expectedPlan?: unknown): HarnessLaunchPlan {
  const parsed = parseAcpHarnessLaunch(launch)
  const built = buildHarnessLaunch({ launch: parsed })
  if (built.kind !== 'exec') throw new Error('Typed harness launch must be shell-free')
  const plan: HarnessLaunchPlan = { version: 1, executable: built.executable, argv: built.argv, env: built.env }
  if (expectedPlan !== undefined && !isDeepStrictEqual(expectedPlan, plan)) {
    throw new Error('Harness launch plan changed; explicit reauthorization is required')
  }
  return plan
}

/** Pure compilation: never detects executables, prepares directories, or starts a process. */
export function buildHarnessLaunch(params: unknown): HarnessLaunchPreview {
  const { launch } = parseBuildHarnessLaunchParams(params)
  const wrapper = Harness.forLaunch(launch)
  return parseHarnessLaunchPreview(wrapper.buildLaunch(launch.kind === 'acp-command'
    ? { customLaunchCommand: launch.command } : launch.options))
}
