/**
 * Setup module — CLI orchestration for `agent-setup.mjs` entry points.
 */

export { runSetup } from './run-setup.js';
export { readManifest } from './manifest.js';
export { HARNESS_REGISTRY } from './harness-registry.js';
export type { HarnessInfo } from './harness-registry.js';
export {
  getHarnessInfo,
  isHarnessInstalled,
  detectInstalledHarnesses,
  getPromptTarget,
} from './harness.js';
export {
  resolveWorkspaceDir,
  createWorkspace,
  isWorkspaceReady,
  distributePrompt,
  copyToWorkspace,
} from './workspace.js';
export type {
  AgentTeamManifest,
  HarnessName,
  HarnessPromptTarget,
  CallbackContext,
  SetupLogger,
  SetupCallbacks,
} from './types.js';
