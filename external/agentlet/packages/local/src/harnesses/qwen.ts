import { defineCommandHarness } from './common/define-command-harness.js'

export const qwenHarness = defineCommandHarness({
  id: 'qwen',
  displayName: 'Qwen Code',
  command: 'qwen',
  acpArgs: ['--acp'],
  autoApproveArgs: ['--approval-mode=yolo'],
  installHint: 'npm install -g @qwen-code/qwen-code',
})
