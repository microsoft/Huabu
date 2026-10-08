import {
  parseAgentProfileLaunch,
  type AgentProfileLaunch,
  type HarnessLaunchPlan,
} from '@agentlet/protocol'
import { compileCustomCommand } from './custom.js'
import { getHarnessDefinition } from './registry.js'
import type { CompiledHarnessLaunch } from './types.js'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateLegacyLaunchPlan(value: unknown): void {
  if (value === undefined) return
  if (!object(value) || value.version !== 1 ||
    typeof value.executable !== 'string' || !value.executable ||
    !Array.isArray(value.argv) || value.argv.some((arg) => typeof arg !== 'string') ||
    !object(value.env) || Object.values(value.env).some((entry) => typeof entry !== 'string')) {
    throw new Error('Invalid legacy harness launch plan')
  }
}

export function compileHarnessLaunch(
  launch: unknown,
  legacyPlan?: HarnessLaunchPlan,
): CompiledHarnessLaunch {
  validateLegacyLaunchPlan(legacyPlan)
  const parsed: AgentProfileLaunch = parseAgentProfileLaunch(launch)
  if (parsed.kind === 'acp-command') return compileCustomCommand(parsed.command)
  if (parsed.harnessId === 'custom') {
    throw new Error('Custom wrapper requires an explicit ACP command launch')
  }
  const definition = getHarnessDefinition(parsed.harnessId)
  if (parsed.options?.autoApprove && !definition.capabilities.autoApprove) {
    throw new Error(`Harness ${parsed.harnessId} does not support auto-approval`)
  }
  return definition.compile(parsed.options)
}
