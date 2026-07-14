/**
 * Setup module — CLI orchestration for `agent-setup.mjs` entry points.
 */

export { runManagedSetup, runSetup, runSetupCommand } from './run-setup.js';
export type { SetupCommandArgs } from './run-setup.js';
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
  copyEntryToWorkspace,
} from './workspace.js';
export type {
  AgentTeamManifest,
  AgentTeamEnvField,
  CliToolRequirement,
  CopyEntry,
  HarnessName,
  HarnessPromptTarget,
  CallbackContext,
  SetupLogger,
  ManagedSetupPhase,
  ManagedSetupProgress,
  ManagedSetupOptions,
  SetupCallbacks,
} from './types.js';
export type {
  ManagedSetupWorkerMessage,
  ManagedSetupWorkerRequest,
} from './worker-protocol.js';
