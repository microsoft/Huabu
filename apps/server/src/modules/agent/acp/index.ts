export {
  mountAgentletServer,
  getAgentletServer,
  ACP_UPGRADE_PATH,
} from './server-mount.js';
export type { MountAcpOptions } from './server-mount.js';

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
} from './translator.js';
export type { TranslatorLogger } from './translator.js';

export { getDaemonAuth } from './daemon-auth.js';
export { getDaemonSupervisor, getDaemonStatus } from './daemon-supervisor.js';
export { installAcpProfileCachePort } from './profile-cache-port.js';
export {
  ensureAgentForThread,
  releaseThread,
  threadKey,
} from './spawn-orchestrator.js';
