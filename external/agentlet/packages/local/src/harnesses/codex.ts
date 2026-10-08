import { commandExists, discoverCommand } from './common/command-discovery.js'
import { compileTrustedCommand } from './common/compile-command.js'
import type { HarnessDefinition } from './types.js'

export const codexHarness: HarnessDefinition = {
  id: 'codex',
  displayName: 'Codex',
  installHint: 'npm install -g @agentclientprotocol/codex-acp',
  capabilities: { customLaunchCommand: false, autoApprove: false },
  async discover() {
    const adapter = await discoverCommand('codex-acp', { probeVersion: false })
    if (adapter.status === 'ready') return adapter
    if (await commandExists('codex')) {
      return {
        status: 'adapter-missing',
        diagnostics: [{ code: 'adapter_missing', message: 'Codex is installed but codex-acp is required' }],
      }
    }
    return adapter
  },
  compile: () => compileTrustedCommand(['codex-acp']),
}
