/**
 * `@agenetes/acp-driver` — the L2 standard driver for ACP-connected
 * external agents, plus its session management.
 *
 * This package holds everything ACP-specific that used to live under
 * `apps/server/src/modules/agent/acp` + `.../agenetes/acp-handle.ts`:
 * the {@link AgentHandle} implementation, the session registry / store,
 * the `ensureAcpSession` orchestration, the `session/update` translator,
 * and the ACP session-meta handling. It builds on the `@agenetes` base
 * (`@agenetes/protocol` + `@agenetes/runtime`) and reaches its transport
 * (`@agenetes/agentlet-host`) as an intra-L2 dependency — no L1 hand-down.
 *
 * Host-specific concerns are injected by L1: a storage root path (where
 * the session store persists), the profile-schema cache port (M3), and
 * the per-turn canvas-coupled render closure. See
 * docs/proposals/layered-architecture.md §7 (M5).
 *
 * NOTE: this is the M5 scaffold entry point. Modules are filled in as
 * each relocation sub-task lands.
 */

export {
  acpUpdateToStreamEvent,
  mergeThinkingChunk,
  getTranslatorCounters,
  resetTranslatorCounters,
} from './translator.js';
export type { TranslatorLogger } from './translator.js';
export { commandFromRawInput } from './command-from-raw-input.js';

export {
  AcpAgentClient,
  pickPermissionOption,
  agentSupportsLoadSession,
} from './client.js';
export type {
  AcpAgentClientOptions,
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpLoadSessionResult,
  AcpPromptResult,
  PermissionNotifier,
  PermissionDecision,
} from './client.js';
