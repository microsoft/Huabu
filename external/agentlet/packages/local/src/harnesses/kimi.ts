import { defineCommandHarness } from './common/define-command-harness.js'

export const kimiHarness = defineCommandHarness({
  id: 'kimi',
  displayName: 'Kimi Code',
  command: 'kimi',
  acpArgs: ['acp'],
  autoApproveArgs: ['--yolo'],
  autoApprovePosition: 'before-acp',
  installHint: 'Install from https://code.kimi.com/',
})
