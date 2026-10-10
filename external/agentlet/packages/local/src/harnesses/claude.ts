import { commandExists, discoverCommand } from './common/command-discovery.js'
import { compileTrustedCommand } from './common/compile-command.js'
import type { HarnessDefinition } from './types.js'

export const claudeHarness: HarnessDefinition = {
  id: 'claude',
  displayName: 'Claude Agent',
  installHint: 'npm install -g @agentclientprotocol/claude-agent-acp',
  capabilities: { customLaunchCommand: false, autoApprove: false },
  async discover() {
    const adapter = await discoverCommand('claude-agent-acp', { probeVersion: false })
    if (adapter.status === 'ready') return adapter
    if (await commandExists('claude')) {
      return {
        status: 'adapter-missing',
        diagnostics: [{ code: 'adapter_missing', message: 'Claude is installed but claude-agent-acp is required' }],
      }
    }
    return adapter
  },
  compile: () => compileTrustedCommand(['claude-agent-acp']),
}
