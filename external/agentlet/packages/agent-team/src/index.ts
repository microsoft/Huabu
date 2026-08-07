/**
 * @agentlet/agent-team
 *
 * Shared runtime for Agent Team packages.
 */

// Setup — CLI orchestration for agent-setup.mjs
export * from './setup/index.js';

// Resolve — Agent Team ref → concrete spawn params (used by daemon)
export { resolveAgentTeam } from './resolve/index.js';
export type { AgentTeamRef, ResolvedSpawn } from './resolve/index.js';

// Discovery — scan one collection root without executing package code
export { scanAgentTeamRoot } from './scan.js';
export type {
  AgentTeamScanMember,
  AgentTeamScanDiagnostic,
  AgentTeamScanResult,
} from './scan.js';

// Validation — inspect a managed deployment without repairing it
export { validateManagedAgentTeam } from './validate.js';
export type {
  ManagedAgentTeamValidationIssue,
  ManagedAgentTeamValidationResult,
} from './validate.js';
