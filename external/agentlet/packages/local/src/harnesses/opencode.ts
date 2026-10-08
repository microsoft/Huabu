import { defineCommandHarness } from './common/define-command-harness.js'

export const opencodeHarness = defineCommandHarness({
  id: 'opencode',
  displayName: 'OpenCode',
  command: 'opencode',
  acpArgs: ['acp'],
  installHint: 'npm install -g opencode-ai@latest',
})
