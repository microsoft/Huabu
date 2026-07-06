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
 * Host-specific concerns are injected by L1: the profile-schema cache
 * port (M3) and the per-turn canvas-coupled render closure. Storage is
 * scoped by the `Namespace` carried on the WorkloadSpec (§7 M5.0), so the
 * session store persists under `namespace.storage.root` without an L1
 * path hand-down. See docs/proposals/layered-architecture.md §7 (M5).
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

export {
  readAcpSessionRecord,
  writeAcpSessionRecord,
  writeAcpSessionMeta,
  deleteAcpSessionRecord,
} from './session-store.js';
export type {
  AcpBindingRecipe,
  AcpSessionPersistedMeta,
  AcpSessionRecord,
} from './session-store.js';

export { acpSessionRegistry } from './session-registry.js';
export type { AcpSessionEntry } from './session-registry.js';

export {
  mergeToolExtension,
  emptyAcpOverlay,
  applyToolExt,
} from './overlay.js';
export type {
  ToolAcpExtension,
  ToolPermissionState,
  AcpTurnOverlay,
} from './overlay.js';

export { AcpAgentHandle, ACP_CAPABILITIES } from './handle.js';
export type {
  InStreamEvent,
  PreparedAcpPrompt,
  AcpTurnCtx,
} from './handle.js';

export { acpDriverFactory, ACP_DRIVER_KIND } from './driver.js';
export type {
  AcpAgentDriver,
  AcpCreateSpec,
  AcpDriverFactoryConfig,
} from './driver.js';

export { AcpServiceError } from './errors.js';
export type { AcpEnsureErrorCode } from './errors.js';

export {
  ensureAgentForThread,
  releaseThread,
  threadKey,
  _resetSpawnOrchestratorForTests,
} from './spawn-orchestrator.js';

export {
  ensureAcpSession,
  promoteEntryToPersisted,
  setAcpProfileCachePort,
} from './session.js';
export type {
  EnsureAcpSessionOptions,
  AcpProfileCachePort,
} from './session.js';
