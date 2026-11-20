// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * L1-owned assembly of the agent reachback environment.
 *
 * When Huabu spawns an external agent it injects a small set of
 * `HUABU_*` environment variables so the agent can reach back into the
 * host over the canvas-scoped Remote File System (RFS) and attribute its
 * change-review activity to the right conversation:
 *
 *   - `HUABU_RFS_URL`   — `<publicOrigin>/api/rfs/w/<workspaceId>/<canvasId>`,
 *                          the canvas-scoped RFS base (capabilities / query /
 *                          download / upload / execute / agent / skill). Bakes the canvasId into the path
 *                          so the agent needs no separate canvas variable.
 *   - `HUABU_THREAD_ID` — the ACP thread this agent serves, so reachback
 *                          `/execute` calls land on this conversation's
 *                          change-review card.
 *
 * This is a **pure L1 concern**: RFS is canvas-coupled and the `HUABU_*`
 * naming + `/api/rfs/` route are Huabu conventions. The assembled env
 * is handed to L2 through its runtime environment port, never frozen into
 * new workload snapshots. The driver applies the opaque patch before spawn
 * without reading the host port or interpreting any key.
 */

import { getAgentletGateway } from '@agenetes/agentlet-host';
import { DAEMON_ENV_KEYS } from '@agentlet/protocol';

import { HUABU_BOOTSTRAP_ENV_KEYS } from '@huabu/client-runtime';

import { getHostServerPort } from '../../../host-port.js';
import {
  agentReachbackEnvironment,
  requireOwnAgentlet,
} from '../../identity/agent-credentials.js';
import { resolveConfiguredPublicOrigin } from '../../security/public-origin.js';
import { resolveCanvasAcpNamespace } from '../../workspace/paths.js';
import { getWorkspaceHandle } from '../../workspace.js';

import type { AcpRuntimePolicy } from '@agenetes/acp-driver';

const REACHBACK_ENV_KEYS = {
  url: 'HUABU_RFS_URL',
  thread: 'HUABU_THREAD_ID',
  token: 'HUABU_RFS_TOKEN',
} as const;

const runtimeOwnedKeys = new Set<string>([
  ...Object.values(REACHBACK_ENV_KEYS),
  ...Object.values(HUABU_BOOTSTRAP_ENV_KEYS),
  ...DAEMON_ENV_KEYS,
]);

/** Strip only known runtime declarations; unknown/user settings remain opaque. */
export function frozenAgentEnvironment<T>(
  env: Record<string, T>,
  platform?: string,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !runtimeOwnedKeys.has(platform === 'win32' ? key.toUpperCase() : key),
    ),
  );
}

export const resolveReachbackRuntimeEnvironment: NonNullable<
  AcpRuntimePolicy['resolveRuntimeEnvironment']
> = async (spec, context) => {
  if (!context) throw new Error('Reachback execution context is unavailable');
  const platform = getAgentletGateway()?.getAgentlet(context.agentletId)
    ?.agentletProfile?.machine?.platform;
  if (
    !platform &&
    Object.keys(spec.env ?? {}).some(
      (key) =>
        key !== key.toUpperCase() && runtimeOwnedKeys.has(key.toUpperCase()),
    )
  )
    throw new Error(
      'Target Agentlet platform is unavailable for environment resolution',
    );
  const frozen = frozenAgentEnvironment(spec.env ?? {}, platform);
  const patch: Record<string, string | undefined> = Object.fromEntries(
    Object.keys(spec.env ?? {})
      .filter((key) => !Object.hasOwn(frozen, key))
      .map((key) => [key, undefined]),
  );
  // A genuinely unscoped execution has no Space reachback capability.
  if (!context.namespace.name) return patch;
  if (!context.threadId)
    throw new Error('Reachback conversation is unavailable');
  const namespace = resolveCanvasAcpNamespace(context.namespace);
  const env = buildReachbackEnv(
    context.threadId,
    namespace.name,
    namespace.ownerId,
  );
  if (!env[REACHBACK_ENV_KEYS.url])
    throw new Error('Reachback server endpoint is unavailable');
  if (spec.agentletId) await requireOwnAgentlet(spec.agentletId);
  const credentials = await agentReachbackEnvironment({
    agentletId: context.agentletId,
    env,
  });
  if (!credentials?.[REACHBACK_ENV_KEYS.token])
    throw new Error('Reachback credential is unavailable');
  return { ...patch, ...env, ...credentials };
};

/**
 * Build the reachback env for an agent serving `threadId` in `canvasId`.
 * `HUABU_RFS_URL` is only included when a canvasId is present and the host
 * server has bound a port; `HUABU_THREAD_ID` is always set.
 */
export function buildReachbackEnv(
  threadId: string,
  canvasId?: string,
  workspaceId = getWorkspaceHandle()?.workspaceId,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (canvasId) {
    let origin = resolveConfiguredPublicOrigin();
    if (!origin) {
      const port = getHostServerPort();
      if (port > 0) origin = `http://127.0.0.1:${port}`;
    }
    if (origin) {
      // Named so the run keeps its Workspace after its starter switches.
      const scope = workspaceId ? `w/${encodeURIComponent(workspaceId)}/` : '';
      env[REACHBACK_ENV_KEYS.url] = new URL(
        `/api/rfs/${scope}${encodeURIComponent(canvasId)}`,
        origin,
      ).toString();
    }
  }
  env[REACHBACK_ENV_KEYS.thread] = threadId;
  return env;
}
