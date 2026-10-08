export interface HarnessCapabilities {
  customLaunchCommand: boolean
  autoApprove: boolean
}

export const CUSTOM_COMMAND_WRAPPER_ID = 'custom' as const

export const CUSTOM_COMMAND_CAPABILITIES = Object.freeze({
  customLaunchCommand: true,
  autoApprove: false,
} as const satisfies HarnessCapabilities)

export interface HarnessLaunchOptions {
  autoApprove?: boolean
}

export interface AcpHarnessLaunch {
  kind: 'acp-harness'
  harnessId: string
  options?: HarnessLaunchOptions
}

export type AgentProfileLaunch = AcpHarnessLaunch | { kind: 'acp-command'; command: string }

/** Legacy persisted launch evidence. New executions compile from launch intent. */
export interface HarnessLaunchPlan {
  version: 1
  executable: string
  argv: string[]
  env: Record<string, string>
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseAgentProfileLaunch(value: unknown): AgentProfileLaunch {
  if (object(value) && value.kind === 'acp-command' &&
    Object.keys(value).every((key) => ['kind', 'command'].includes(key)) &&
    typeof value.command === 'string' && value.command.trim() && !value.command.includes('\0')) {
    return { kind: 'acp-command', command: value.command }
  }
  return parseAcpHarnessLaunch(value)
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
