// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Centralized API route builders.
 *
 * Every front-end fetch should construct its URL from this module instead
 * of hard-coding template strings. Benefits:
 *   - One canonical URL per server route (no drift if a path is renamed).
 *   - `encodeURIComponent` is applied uniformly so callers never forget it.
 *   - Path-typos surface at compile time.
 */

const enc = encodeURIComponent;

export const routes = {
  // ── Deployment ────────────────────────────────────────────────────
  deploymentReadiness: '/deployment/readiness',

  // ── Workspace ─────────────────────────────────────────────────────
  workspace: '/workspace',
  workspacePickFolder: '/workspace/pick-folder',
  workspaceValidatePath: '/workspace/validate-path',
  workspaces: '/workspaces',
  workspaceById: (workspaceId: string) => `/workspaces/${enc(workspaceId)}`,
  workspaceActivate: (workspaceId: string) =>
    `/workspaces/${enc(workspaceId)}/activate`,

  // ── LLM ───────────────────────────────────────────────────────────
  llmConfig: '/llm/config',
  llmImageConfig: '/llm/image-config',
  llmUtilityConfig: '/llm/utility-config',
  llmProviders: '/llm/providers',
  llmModels: (provider: string) => `/llm/models?provider=${enc(provider)}`,
  llmOAuthDeviceCode: '/llm/oauth/device-code',
  llmOAuthPoll: '/llm/oauth/poll',
  llmOAuthStatus: '/llm/oauth/status',
  llmOAuthLogout: '/llm/oauth/logout',

  // ── Integrations (third-party API keys) ──────────────────────────
  integrationsConfig: '/integrations/config',

  // ── Agent Team Settings (loopback-only) ─────────────────────────
  agentTeamSettings: '/agent-team/settings',
  agentTeamMemberDetail: '/agent-team/settings/member-detail',
  agentTeamConfigs: '/agent-team/settings/configs',
  agentTeamProfiles: '/agent-team/settings/profiles',
  agentTeamProfile: (id: string) => `/agent-team/settings/profiles/${enc(id)}`,
  agentTeamProfileAction: (id: string, action: 'setup' | 'cancel') =>
    `/agent-team/settings/profiles/${enc(id)}/${action}`,

  // ── Canvas ────────────────────────────────────────────────────────
  canvasList: '/canvas',
  canvasImport: '/canvas/import',
  canvas: (canvasId: string) => `/canvas/${enc(canvasId)}`,
  canvasExecute: (canvasId: string) => `/canvas/${enc(canvasId)}/execute`,
  canvasReferences: (canvasId: string) => `/canvas/${enc(canvasId)}/references`,
  canvasPreviewScene: (canvasId: string) =>
    `/canvas/${enc(canvasId)}/preview-scene`,
  canvasExport: (canvasId: string) => `/canvas/${enc(canvasId)}/export`,
  canvasNode: (canvasId: string, nodeId: string) =>
    `/canvas/${enc(canvasId)}/nodes/${enc(nodeId)}`,
  canvasNodeContent: (canvasId: string, nodeId: string) =>
    `/canvas/${enc(canvasId)}/nodes/${enc(nodeId)}/content`,
  canvasNodePreprocess: (canvasId: string, nodeId: string) =>
    `/canvas/${enc(canvasId)}/nodes/${enc(nodeId)}/preprocess`,
  canvasRevealNodes: (canvasId: string) =>
    `/canvas/${enc(canvasId)}/reveal-nodes`,
  canvasSearch: (canvasId: string) => `/canvas/${enc(canvasId)}/search`,
  canvasArtifact: (
    canvasId: string,
    kind: 'image' | 'pdf' | 'office' | 'video' | 'audio' | 'html',
  ) => `/canvas/${enc(canvasId)}/artifact/${kind}`,
  canvasArtifactCloneFrom: (canvasId: string) =>
    `/canvas/${enc(canvasId)}/artifact/clone-from`,
  canvasEvents: (canvasId: string) => `/canvas/${enc(canvasId)}/events`,
  canvasExternalStream: (canvasId: string) =>
    `/canvas/${enc(canvasId)}/external/stream`,
  canvasExternalImport: (canvasId: string) =>
    `/canvas/${enc(canvasId)}/external/import`,
  canvasSyncStream: (canvasId: string) =>
    `/canvas/${enc(canvasId)}/sync/stream`,
  canvasThreadChanges: (canvasId: string, threadId: string) =>
    `/canvas/${enc(canvasId)}/threads/${enc(threadId)}/changes`,
  canvasThreadChange: (canvasId: string, threadId: string, changeId: string) =>
    `/canvas/${enc(canvasId)}/threads/${enc(threadId)}/changes/${enc(changeId)}`,
  canvasThreadChangeRevert: (
    canvasId: string,
    threadId: string,
    changeId: string,
  ) =>
    `/canvas/${enc(canvasId)}/threads/${enc(threadId)}/changes/${enc(changeId)}/revert`,

  // ── Web (preview / reader / page) ────────────────────────────────
  webPreview: (canvasId: string, nodeId: string) =>
    `/web/preview?canvasId=${enc(canvasId)}&nodeId=${enc(nodeId)}`,
  webReader: (canvasId: string, nodeId: string) =>
    `/web/reader?canvasId=${enc(canvasId)}&nodeId=${enc(nodeId)}`,
  webPage: (canvasId: string, nodeId: string) =>
    `/web/page?canvasId=${enc(canvasId)}&nodeId=${enc(nodeId)}`,

  // ── Interactive Views ────────────────────────────────────────────
  interactiveView: (canvasId: string, nodeId: string) =>
    `/interactive-views/${enc(canvasId)}/${enc(nodeId)}`,
  interactiveViewRuntime: (canvasId: string, nodeId: string) =>
    `/interactive-views/${enc(canvasId)}/${enc(nodeId)}/runtime`,
  interactiveViewState: (canvasId: string, nodeId: string) =>
    `/interactive-views/${enc(canvasId)}/${enc(nodeId)}/state`,
  interactiveViewAction: (canvasId: string, nodeId: string, actionId: string) =>
    `/interactive-views/${enc(canvasId)}/${enc(nodeId)}/actions/${enc(actionId)}`,

  // ── Agent ─────────────────────────────────────────────────────────
  agent: '/agent',
  agentHistory: (threadId: string, canvasId?: string) => {
    const params = canvasId ? `?canvasId=${enc(canvasId)}` : '';
    return `/agent/history/${enc(threadId)}${params}`;
  },
  agentHistoryFork: (threadId: string, canvasId?: string) => {
    const params = canvasId ? `?canvasId=${enc(canvasId)}` : '';
    return `/agent/history/${enc(threadId)}/fork${params}`;
  },
  agentStop: (threadId: string) => `/agent/stop/${enc(threadId)}`,
  agentStream: (threadId: string, canvasId?: string) => {
    const params = canvasId ? `?canvasId=${enc(canvasId)}` : '';
    return `/agent/stream/${enc(threadId)}${params}`;
  },
  agentContextTokens: (threadId: string, canvasId?: string) => {
    const params = canvasId ? `?canvasId=${enc(canvasId)}` : '';
    return `/agent/context-tokens/${enc(threadId)}${params}`;
  },

  // ── ACP (external agent bridge) ───────────────────────────────────
  acpAgentCli: '/acp/agent-cli',
  // Profiles (loopback-only) — user-managed spawn recipes.
  acpProfiles: '/acp/profiles',
  acpProfileItem: (id: string) => `/acp/profiles/${enc(id)}`,
  // Embedded agentlet daemon — health + manual restart.
  acpAgentlet: '/acp/agentlet',
  acpAgentletRestart: '/acp/agentlet/restart',
  acpRuntimeConfig: '/acp/runtime-config',
  acpThreadSession: (threadId: string) =>
    `/acp/threads/${enc(threadId)}/session`,
  acpThreadCommands: (threadId: string, canvasId?: string) => {
    const params = canvasId ? `?canvasId=${enc(canvasId)}` : '';
    return `/acp/threads/${enc(threadId)}/commands${params}`;
  },
  acpThreadCachedMeta: (
    threadId: string,
    canvasId?: string,
    profileId?: string,
  ) => {
    const qs: string[] = [];
    if (canvasId) qs.push(`canvasId=${enc(canvasId)}`);
    if (profileId) qs.push(`profileId=${enc(profileId)}`);
    const params = qs.length ? `?${qs.join('&')}` : '';
    return `/acp/threads/${enc(threadId)}/cached-meta${params}`;
  },
  acpThreadPermission: (threadId: string) =>
    `/acp/threads/${enc(threadId)}/permission`,
  acpThreadMode: (threadId: string) => `/acp/threads/${enc(threadId)}/mode`,
  acpThreadModel: (threadId: string) => `/acp/threads/${enc(threadId)}/model`,
  acpThreadConfigOption: (threadId: string) =>
    `/acp/threads/${enc(threadId)}/config-option`,

  // ── Built-in agent per-thread settings ────────────────────────────
  agentThreadSettings: (threadId: string, canvasId?: string) =>
    `/agent/threads/${enc(threadId)}/settings${
      canvasId ? `?canvasId=${enc(canvasId)}` : ''
    }`,
  agentThreadModel: (threadId: string) =>
    `/agent/threads/${enc(threadId)}/model`,
  agentThreadReasoningEffort: (threadId: string) =>
    `/agent/threads/${enc(threadId)}/reasoning-effort`,

  // ── Skills (user-invokable catalogue) ─────────────────────────────
  skillsList: (scope?: string) => {
    const params = scope ? `?scope=${enc(scope)}` : '';
    return `/skills/${params}`;
  },
} as const;
