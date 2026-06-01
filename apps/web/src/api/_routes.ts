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
  // ── Workspace ─────────────────────────────────────────────────────
  workspace: '/workspace',
  workspacePickFolder: '/workspace/pick-folder',
  workspaceValidatePath: '/workspace/validate-path',

  // ── LLM ───────────────────────────────────────────────────────────
  llmConfig: '/llm/config',
  llmProviders: '/llm/providers',
  llmModels: (provider: string) => `/llm/models?provider=${enc(provider)}`,
  llmOAuthDeviceCode: '/llm/oauth/device-code',
  llmOAuthPoll: '/llm/oauth/poll',
  llmOAuthStatus: '/llm/oauth/status',
  llmOAuthLogout: '/llm/oauth/logout',

  // ── Canvas ────────────────────────────────────────────────────────
  canvasList: '/canvas',
  canvasImport: '/canvas/import',
  canvas: (canvasId: string) => `/canvas/${enc(canvasId)}`,
  canvasExport: (canvasId: string) => `/canvas/${enc(canvasId)}/export`,
  canvasNode: (canvasId: string, nodeId: string) =>
    `/canvas/${enc(canvasId)}/nodes/${enc(nodeId)}`,
  canvasNodeContent: (canvasId: string, nodeId: string) =>
    `/canvas/${enc(canvasId)}/nodes/${enc(nodeId)}/content`,
  canvasNodePreprocess: (canvasId: string, nodeId: string) =>
    `/canvas/${enc(canvasId)}/nodes/${enc(nodeId)}/preprocess`,
  canvasArtifact: (canvasId: string, kind: 'image' | 'pdf' | 'video') =>
    `/canvas/${enc(canvasId)}/artifact/${kind}`,
  canvasArtifactCloneFrom: (canvasId: string) =>
    `/canvas/${enc(canvasId)}/artifact/clone-from`,
  canvasEvents: (canvasId: string) => `/canvas/${enc(canvasId)}/events`,

  // ── Web (preview / reader) ────────────────────────────────────────
  webPreview: (canvasId: string, nodeId: string) =>
    `/web/preview?canvasId=${enc(canvasId)}&nodeId=${enc(nodeId)}`,
  webReader: (canvasId: string, nodeId: string) =>
    `/web/reader?canvasId=${enc(canvasId)}&nodeId=${enc(nodeId)}`,

  // ── Intent ────────────────────────────────────────────────────────
  intentRecognizeStream: '/intent/recognize-stream',
  intentRecognizeSketch: '/intent/recognize-sketch',
  intentEpisode: '/intent/episode',

  // ── Agent ─────────────────────────────────────────────────────────
  agent: '/agent',
  agentHistory: (threadId: string, canvasId?: string) => {
    const params = canvasId ? `?canvasId=${enc(canvasId)}` : '';
    return `/agent/history/${enc(threadId)}${params}`;
  },
  agentStop: (threadId: string) => `/agent/stop/${enc(threadId)}`,
  agentStream: (threadId: string) => `/agent/stream/${enc(threadId)}`,
  agentContextTokens: (threadId: string, canvasId?: string) => {
    const params = canvasId ? `?canvasId=${enc(canvasId)}` : '';
    return `/agent/context-tokens/${enc(threadId)}${params}`;
  },

  // ── ACP (external agent bridge) ───────────────────────────────────
  acpAgents: '/acp/agents',
  acpThreadSession: (threadId: string) =>
    `/acp/threads/${enc(threadId)}/session`,
  acpThreadCommands: (threadId: string) =>
    `/acp/threads/${enc(threadId)}/commands`,
  acpThreadPermission: (threadId: string) =>
    `/acp/threads/${enc(threadId)}/permission`,
  acpThreadMode: (threadId: string) => `/acp/threads/${enc(threadId)}/mode`,
  acpThreadModel: (threadId: string) => `/acp/threads/${enc(threadId)}/model`,
  acpThreadConfigOption: (threadId: string) =>
    `/acp/threads/${enc(threadId)}/config-option`,

  // ── Skills (user-invokable catalogue) ─────────────────────────────
  skillsList: (scope?: string) => {
    const params = scope ? `?scope=${enc(scope)}` : '';
    return `/skills/${params}`;
  },
} as const;
