import { defineCommandHarness } from './common/define-command-harness.js'

export const cursorHarness = defineCommandHarness({
  id: 'cursor',
  displayName: 'Cursor',
  command: 'agent',
  acpArgs: ['acp'],
  autoApproveArgs: ['--yolo'],
  autoApprovePosition: 'before-acp',
  installHint: 'Install from https://cursor.com/docs/cli/installation',
})
