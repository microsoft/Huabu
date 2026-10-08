import type { HarnessLaunchOptions } from '@agentlet/protocol'
import { compileTrustedCommand } from './compile-command.js'
import { discoverCommand } from './command-discovery.js'
import type { HarnessDefinition } from '../types.js'

export function defineCommandHarness(config: {
  id: string
  displayName: string
  command: string
  acpArgs: readonly string[]
  autoApproveArgs?: readonly string[]
  autoApprovePosition?: 'before-acp' | 'after-acp'
  installHint: string
  probeVersion?: boolean
}): HarnessDefinition {
  const supportsAutoApprove = config.autoApproveArgs !== undefined
  return {
    id: config.id,
    displayName: config.displayName,
    installHint: config.installHint,
    capabilities: { customLaunchCommand: false, autoApprove: supportsAutoApprove },
    discover: () => discoverCommand(config.command, { probeVersion: config.probeVersion }),
    compile(options: HarnessLaunchOptions = {}) {
      if (options.autoApprove && !supportsAutoApprove) {
        throw new Error(`Harness '${config.id}' does not support launch-time autoApprove`)
      }
      const approval = options.autoApprove ? config.autoApproveArgs ?? [] : []
      const args = config.autoApprovePosition === 'before-acp'
        ? [...approval, ...config.acpArgs]
        : [...config.acpArgs, ...approval]
      return compileTrustedCommand([config.command, ...args])
    },
  }
}
