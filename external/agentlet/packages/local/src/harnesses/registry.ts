import { claudeHarness } from './claude.js'
import { codebuddyHarness } from './codebuddy.js'
import { codexHarness } from './codex.js'
import { copilotHarness } from './copilot.js'
import { cursorHarness } from './cursor.js'
import { customHarness } from './custom.js'
import { geminiHarness } from './gemini.js'
import { hermesHarness } from './hermes.js'
import { kimiHarness } from './kimi.js'
import { opencodeHarness } from './opencode.js'
import { qwenHarness } from './qwen.js'
import type { HarnessDefinition } from './types.js'

export const HARNESS_DEFINITIONS: readonly HarnessDefinition[] = [
  copilotHarness,
  claudeHarness,
  geminiHarness,
  codexHarness,
  qwenHarness,
  kimiHarness,
  opencodeHarness,
  cursorHarness,
  codebuddyHarness,
  hermesHarness,
  customHarness,
]

export function getHarnessDefinition(id: string): HarnessDefinition {
  const definition = HARNESS_DEFINITIONS.find((candidate) => candidate.id === id)
  if (!definition) throw new Error(`Unknown harness: ${id}`)
  return definition
}
