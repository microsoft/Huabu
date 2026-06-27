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
