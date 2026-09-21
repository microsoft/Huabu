/** Capabilities describe this catalogue entry's ACP transport, not its native CLI. */
export type HarnessCapabilityStatus = 'supported' | 'unsupported' | 'unknown'

export interface HarnessCapabilities {
  /** Absent on older daemons; absence is not evidence of support. */
  customLaunchCommand?: HarnessCapabilityStatus
  autoApprove: HarnessCapabilityStatus
  modelOverride: HarnessCapabilityStatus
  sessionPersistence: HarnessCapabilityStatus
}

export const CUSTOM_COMMAND_WRAPPER_ID = 'custom' as const

export const CUSTOM_COMMAND_CAPABILITIES = Object.freeze({
  customLaunchCommand: 'supported',
  autoApprove: 'unsupported',
  modelOverride: 'unsupported',
  sessionPersistence: 'unsupported',
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

export interface BuildHarnessLaunchParams {
  launch: AgentProfileLaunch
}

export type HarnessLaunchPreview =
  | { kind: 'exec'; executable: string; argv: string[]; env: Record<string, string> }
  | { kind: 'shell'; command: string }

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

export function parseAgentProfileLaunch(value: unknown): AgentProfileLaunch {
  if (object(value) && value.kind === 'acp-command' &&
    Object.keys(value).every((key) => ['kind', 'command'].includes(key)) &&
    typeof value.command === 'string' && value.command.trim() && !value.command.includes('\0')) {
    return { kind: 'acp-command', command: value.command }
  }
  return parseAcpHarnessLaunch(value)
}

export function parseBuildHarnessLaunchParams(value: unknown): BuildHarnessLaunchParams {
  if (!object(value) || Object.keys(value).some((key) => key !== 'launch')) {
    throw new Error('Expected only a Profile launch')
  }
  return { launch: parseAgentProfileLaunch(value.launch) }
}

export function parseHarnessLaunchPreview(value: unknown): HarnessLaunchPreview {
  const text = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0')
  if (object(value)) {
    if (value.kind === 'shell' && Object.keys(value).every((key) => ['kind', 'command'].includes(key)) &&
      text(value.command) && value.command.trim()) return { kind: 'shell', command: value.command }
    if (value.kind === 'exec' && Object.keys(value).every((key) => ['kind', 'executable', 'argv', 'env'].includes(key)) &&
      text(value.executable) && value.executable.trim() && value.executable.length <= 4096 &&
      Array.isArray(value.argv) && value.argv.length <= 128 && value.argv.every((arg) => text(arg) && arg.length <= 4096) &&
      object(value.env) && Object.entries(value.env).every(([key, val]) => text(key) && key.length <= 256 && text(val) && val.length <= 4096)) {
      return { kind: 'exec', executable: value.executable, argv: [...value.argv], env: { ...value.env } as Record<string, string> }
    }
  }
  throw new Error('Invalid harness launch preview')
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
