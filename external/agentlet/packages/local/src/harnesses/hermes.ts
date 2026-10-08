import { defineCommandHarness } from './common/define-command-harness.js'

export const hermesHarness = defineCommandHarness({
  id: 'hermes',
  displayName: 'Hermes Agent',
  command: 'hermes',
  acpArgs: ['acp'],
  installHint: 'Install from https://hermes-agent.nousresearch.com/docs/user-guide/features/acp',
  probeVersion: false,
})
