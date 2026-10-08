import { parseAgentProfileLaunch, CUSTOM_COMMAND_CAPABILITIES } from '@agentlet/protocol'
import type { HarnessDefinition } from './types.js'

export const customHarness: HarnessDefinition = {
  id: 'custom',
  displayName: 'Custom command',
  installHint: '',
  capabilities: CUSTOM_COMMAND_CAPABILITIES,
  async discover() {
    return { status: 'ready' }
  },
  compile() {
    throw new Error('Custom command compilation requires an explicit command')
  },
}

export function compileCustomCommand(command: unknown) {
  const launch = parseAgentProfileLaunch({ kind: 'acp-command', command })
  if (launch.kind !== 'acp-command') throw new Error('Custom command is required')
  return { kind: 'shell' as const, command: launch.command }
}
