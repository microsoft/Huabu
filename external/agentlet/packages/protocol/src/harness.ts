/** Capabilities describe this catalogue entry's ACP transport, not its native CLI. */
export type HarnessCapabilityStatus = 'supported' | 'unsupported' | 'unknown'

export interface HarnessCapabilities {
  autoApprove: HarnessCapabilityStatus
  modelOverride: HarnessCapabilityStatus
  sessionPersistence: HarnessCapabilityStatus
}

export interface HarnessLaunchOptions {
  autoApprove?: boolean
}

export interface AcpHarnessLaunch {
  kind: 'acp-harness'
  harnessId: string
  options?: HarnessLaunchOptions
}

/** Catalogue-resolved process arguments. Never interpreted by a shell. */
export interface HarnessLaunchPlan {
  version: 1
  executable: string
  argv: string[]
  env: Record<string, string>
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strict portable validation; the daemon separately checks its own catalogue. */
export function parseAcpHarnessLaunch(value: unknown): AcpHarnessLaunch {
  if (!object(value) || value.kind !== 'acp-harness' ||
    typeof value.harnessId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.harnessId) ||
    Object.keys(value).some((key) => !['kind', 'harnessId', 'options'].includes(key))) {
    throw new Error('Expected an ACP harness launch with a bounded harnessId')
  }
  if (value.options !== undefined && (!object(value.options) ||
    Object.keys(value.options).some((key) => key !== 'autoApprove') ||
    ('autoApprove' in value.options && typeof value.options.autoApprove !== 'boolean'))) {
    throw new Error('Harness options accept only optional boolean autoApprove')
  }
  return {
    kind: 'acp-harness',
    harnessId: value.harnessId,
    ...(value.options === undefined ? {} : { options: { ...value.options } }),
  }
}
