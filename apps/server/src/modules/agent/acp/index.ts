export {
  mountAgenetes,
  getAgentletServer,
  ACP_UPGRADE_PATH,
} from '@agenetes/agentlet-host';
export type {
  MountAcpOptions,
  MountAgenetesOptions,
} from '@agenetes/agentlet-host';

export { default as acpThreadsRoutes } from './threads.route.js';
export { default as acpAgentCliRoutes } from './agent-cli.route.js';
export { default as acpProfilesRoutes } from './profiles.route.js';
export { default as acpAgentletRoutes } from './daemon.route.js';
/** @deprecated Use {@link acpAgentletRoutes} instead. */
export { default as acpDaemonRoutes } from './daemon.route.js';

export { AcpAgentClient } from './client.js';
export type {
  AcpAgentClientOptions,
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpPromptResult,
} from './client.js';

export {
  acpUpdateToStreamEvent,
  getTranslatorCounters,
  resetTranslatorCounters,
} from '@agenetes/acp-driver';
export type { TranslatorLogger } from '@agenetes/acp-driver';

export { getDaemonAuth } from '@agenetes/agentlet-host';
export { getDaemonSupervisor, getDaemonStatus } from '@agenetes/agentlet-host';
export { resolveDaemonEntry } from './daemon-entry.js';
export { installAcpProfileCachePort } from './profile-cache-port.js';
export {
  ensureAgentForThread,
  releaseThread,
  threadKey,
} from './spawn-orchestrator.js';
