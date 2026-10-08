import { defineCommandHarness } from './common/define-command-harness.js'

export const copilotHarness = defineCommandHarness({
  id: 'copilot',
  displayName: 'GitHub Copilot',
  command: 'copilot',
  acpArgs: ['--acp'],
  autoApproveArgs: ['--allow-all'],
  installHint: 'npm install -g @github/copilot',
})
