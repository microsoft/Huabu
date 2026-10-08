import { defineCommandHarness } from './common/define-command-harness.js'

export const codebuddyHarness = defineCommandHarness({
  id: 'codebuddy',
  displayName: 'CodeBuddy',
  command: 'codebuddy',
  acpArgs: ['--acp'],
  installHint: 'npm install -g @tencent-ai/codebuddy-code',
})
