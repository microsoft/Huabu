import { isDeepStrictEqual } from 'node:util'
import { parseAcpHarnessLaunch } from '@agentlet/protocol'
import type { HarnessCapabilities, HarnessLaunchOptions, HarnessLaunchPlan } from '@agentlet/protocol'
import { KNOWN_CLIS, type KnownCli } from './catalogue.js'

export interface HarnessLaunchIntent {
  autoApprove?: boolean
  /** ACP preference only; never translated into guessed command-line arguments. */
  model?: string
}

export interface HarnessBuiltLaunch extends HarnessLaunchPlan {
  initialPreferences?: { model: string }
}

/** A typed wrapper over a trusted ACP catalogue entry, not editable Profile metadata. */
export class Harness {
  private constructor(private readonly entry: KnownCli) {}

  static get(harnessId: string): Harness {
    const entry = KNOWN_CLIS.find((candidate) => candidate.id === harnessId)
    if (!entry) throw new Error(`Unknown harness: ${harnessId}`)
    return new Harness(entry)
  }

  describeCapabilities(): HarnessCapabilities {
    return {
      autoApprove: this.entry.autoApprove ? 'supported' : 'unsupported',
      modelOverride: 'unknown',
      sessionPersistence: 'unknown',
    }
  }

  buildLaunch(intent: HarnessLaunchIntent = {}): HarnessBuiltLaunch {
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
      version: 1,
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
  const plan = Harness.get(parsed.harnessId).buildLaunch(parsed.options)
  if (expectedPlan !== undefined && !isDeepStrictEqual(expectedPlan, plan)) {
    throw new Error('Harness launch plan changed; explicit reauthorization is required')
  }
  return plan
}
