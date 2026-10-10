import { defineCommandHarness } from './common/define-command-harness.js'

export const geminiHarness = defineCommandHarness({
  id: 'gemini',
  displayName: 'Gemini',
  command: 'gemini',
  acpArgs: ['--acp'],
  autoApproveArgs: ['--approval-mode=yolo'],
  installHint: 'npm install -g @google/gemini-cli',
})
