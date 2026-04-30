/**
 * Tool Executor
 *
 * Implements the actual execution of each tool. Takes a tool call from the LLM
 * and returns a text result to be fed back as a toolResult message.
 */

import { SKILL_REGISTRY } from '../../../prompt/skills/index.js';
import { getPreprocessDispatcher } from '../../preprocessing/index.js';
import { getCanvasStore } from '../../storage/index.js';

import type {
  AgentMode,
  BlockProvenanceMap,
  CanvasNodeKind,
  NodeOrigin,
} from '@sediment/shared';

// ==================== Origin Helper ====================

function agentModeToOrigin(_mode?: AgentMode): NodeOrigin {
  return { type: 'ai-operate' };
}

/** Build an `__all__` sentinel provenance map for AI-generated content. */
function buildAIProvenance(mode?: AgentMode): BlockProvenanceMap {
  return {
    __all__: {
      author: 'ai',
      agentMode: mode ?? 'operate',
      createdAt: new Date().toISOString(),
    },
  };
}

// ==================== Web Search ====================

async function executeWebSearch(args: {
  query: string;
  max_results?: number;
  search_depth?: 'basic' | 'advanced';
  include_answer?: boolean;
}): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return JSON.stringify({
      tool: 'web_search',
      status: 'error',
      error: 'Missing TAVILY_API_KEY in environment variables.',
      hint: 'Set TAVILY_API_KEY in apps/server/.env to enable web_search.',
    });
  }

  const controller = new AbortController();
  const timeoutMs = 15_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: args.query,
        search_depth: args.search_depth ?? 'basic',
        max_results: args.max_results ?? 5,
        include_answer: args.include_answer ?? true,
        include_raw_content: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return JSON.stringify({
        tool: 'web_search',
        status: 'error',
        error: `Tavily request failed with status ${response.status}.`,
      });
    }

    const data = (await response.json()) as {
      answer?: string;
      query?: string;
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        score?: number;
        favicon?: string;
      }>;
    };

    const results = (data.results ?? [])
      .filter((r) => typeof r?.url === 'string' && r.url.length > 0)
      .map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        content: r.content ?? '',
        favicon: r.favicon ?? '',
        score: typeof r.score === 'number' ? r.score : undefined,
      }));

    return JSON.stringify({
      tool: 'web_search',
      status: 'success',
      data: {
        query: data.query ?? args.query,
        answer: data.answer,
        results,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[web_search] Tavily request failed:', message);
    return JSON.stringify({
      tool: 'web_search',
      status: 'error',
      error: 'Tavily request failed.',
    });
  } finally {
    clearTimeout(timeout);
  }
}

// ==================== Shared Helpers ====================

/**
 * Like extractPreview but accepts an already-parsed meta object to avoid re-parsing.
 */
function extractPreviewFromParsed(
  meta: Record<string, unknown> | null,
  contentFallback?: string,
): { summary?: string; keywords?: string[]; snippet?: string } {
  if (meta) {
    const summary =
      typeof meta.summary === 'string' && meta.summary.trim()
        ? meta.summary.trim()
        : undefined;
    const keywords = Array.isArray(meta.keywords)
      ? (meta.keywords.filter(
          (k): k is string => typeof k === 'string' && k.trim().length > 0,
        ) as string[])
      : undefined;
    if (summary || (keywords && keywords.length > 0)) {
      return { summary, keywords };
    }
  }
  return {
    snippet: contentFallback ? contentFallback.slice(0, 120) : undefined,
  };
}

// ==================== Canvas Operations ====================

/** Summary shape returned by buildNodeSummaries. */
export interface NodePreview {
  nodeId: string;
  sourceId?: string;
  type: string | undefined;
  title: string | undefined;
  parentId: string | undefined;
  summary?: string;
  keywords?: string[];
  snippet?: string;
}

/**
 * Build lightweight preview summaries for canvas nodes.
 *
 * Shared by `get_canvas_state` (all nodes) and agent context injection
 * (selected nodes only). Each node gets at most a summary/keywords from
 * preprocessed metaJson, or a 120-char content snippet — never full content.
 *
 * @param canvasId  Canvas to read
 * @param filterNodeIds  When provided, only return previews for these node IDs.
 * @returns null if the canvas does not exist.
 */
export async function buildNodeSummaries(
  canvasId: string,
  filterNodeIds?: Set<string>,
): Promise<{
  nodes: NodePreview[];
  edges: Array<{ source: string; target: string }>;
  version: number;
} | null> {
  const canvas = getCanvasStore(canvasId).read();
  if (!canvas) return null;
  const store = getCanvasStore(canvasId);

  const allNodes = (canvas.state.nodes ?? []) as Array<Record<string, unknown>>;
  const allEdges = (canvas.state.edges ?? []) as Array<Record<string, unknown>>;

  const nodes = filterNodeIds
    ? allNodes.filter((n) => filterNodeIds.has(n.id as string))
    : allNodes;

  const nodeSummaries: NodePreview[] = nodes.map((n) => {
    const data = n.data as Record<string, unknown> | undefined;
    const nodeId = n.id as string;
    const nodeContent = nodeId ? store.readNode(nodeId) : null;
    const content =
      nodeContent?.content ?? (data?.content as string | undefined);
    const meta = (nodeContent?.metadata ?? null) as Record<
      string,
      unknown
    > | null;
    const preview = extractPreviewFromParsed(meta, content);

    return {
      nodeId,
      sourceId: nodeId,
      type: (n.type ?? data?.type) as string | undefined,
      title: data?.label as string | undefined,
      parentId: n.parentId as string | undefined,
      ...preview,
    };
  });

  const edges = filterNodeIds
    ? []
    : allEdges.map((e) => ({
        source: e.source as string,
        target: e.target as string,
      }));

  return { nodes: nodeSummaries, edges, version: canvas.version };
}

async function executeGetNodeDetail(args: {
  nodeId: string;
  canvasId: string;
}): Promise<string> {
  const store = getCanvasStore(args.canvasId);
  const canvas = store.read();
  if (!canvas) {
    return JSON.stringify({ error: `Canvas ${args.canvasId} not found` });
  }

  const nodes = (canvas.state.nodes ?? []) as Array<Record<string, unknown>>;
  const node = nodes.find((n) => n.id === args.nodeId);
  if (!node) {
    return JSON.stringify({
      error: `Node ${args.nodeId} not found in canvas ${args.canvasId}`,
    });
  }

  const data = node.data as Record<string, unknown> | undefined;
  const nodeContent = store.readNode(args.nodeId);
  const content = nodeContent?.content ?? (data?.content as string | undefined);

  return JSON.stringify({
    id: node.id,
    type: node.type ?? data?.type,
    label: data?.label,
    content,
    src: data?.src ?? nodeContent?.src ?? undefined,
    sourceId: args.nodeId,
    position: node.position,
    width: node.width,
    height: node.height,
    parentId: node.parentId,
  });
}

async function executeGetCanvasState(args: {
  canvasId: string;
}): Promise<string> {
  const result = await buildNodeSummaries(args.canvasId);
  if (!result) {
    return JSON.stringify({ error: `Canvas ${args.canvasId} not found` });
  }

  return JSON.stringify({
    canvasId: args.canvasId,
    version: result.version,
    nodeCount: result.nodes.length,
    edgeCount: result.edges.length,
    nodes: result.nodes,
    edges: result.edges,
  });
}

// ==================== Canvas Commands ====================

async function executeCanvasCommands(
  args: {
    canvasId: string;
    commands: Array<Record<string, unknown>>;
  },
  context?: { mode?: AgentMode },
): Promise<string> {
  const origin = agentModeToOrigin(context?.mode);

  // Read canvas state once so we can resolve node types for provenance injection.
  const canvas = getCanvasStore(args.canvasId).read();
  const nodeTypeMap = new Map<string, string>();
  if (canvas) {
    for (const n of (canvas.state.nodes ?? []) as Array<
      Record<string, unknown>
    >) {
      const data = (n.data as Record<string, unknown> | undefined) ?? {};
      const nodeType = (n.nodeType ?? n.type ?? data.type) as
        | string
        | undefined;
      if (typeof n.id === 'string' && typeof nodeType === 'string') {
        nodeTypeMap.set(n.id, nodeType);
      }
    }
  }

  const commands = args.commands.map((cmd) => {
    if (cmd.type === 'CREATE_NODES') {
      const nodes = cmd.nodes as Array<Record<string, unknown>>;
      return {
        ...cmd,
        nodes: nodes.map((node) => {
          const data = (node.data as Record<string, unknown> | undefined) ?? {};
          const isNote = node.nodeType === 'note';
          const hasContent =
            isNote &&
            typeof data.content === 'string' &&
            data.content.length > 0;
          const hasLabel = typeof data.label === 'string';
          return {
            ...node,
            data: {
              ...data,
              origin,
              ...(hasContent
                ? { provenance: buildAIProvenance(context?.mode) }
                : {}),
              ...(hasLabel ? { labelSource: 'agent' as const } : {}),
            },
          };
        }),
      };
    }
    if (cmd.type === 'MERGE_NODE_DATA') {
      const patches = cmd.patches as Array<Record<string, unknown>>;
      return {
        ...cmd,
        patches: patches.map((entry) => {
          const patch =
            (entry.patch as Record<string, unknown> | undefined) ?? {};
          const nodeId = entry.nodeId as string | undefined;
          const isNote = nodeId ? nodeTypeMap.get(nodeId) === 'note' : false;
          const hasContent =
            isNote &&
            typeof patch.content === 'string' &&
            patch.content.length > 0;
          const hasLabel = typeof patch.label === 'string';
          const extra: Record<string, unknown> = {};
          if (hasContent) extra.provenance = buildAIProvenance(context?.mode);
          if (hasLabel) extra.labelSource = 'agent';
          if (Object.keys(extra).length > 0) {
            return {
              ...entry,
              patch: { ...patch, ...extra },
            };
          }
          return entry;
        }),
      };
    }
    if (cmd.type === 'CREATE_QUESTION') {
      const raw = cmd as Record<string, unknown>;
      return {
        ...raw,
        origin,
      };
    }
    return cmd;
  });

  return JSON.stringify({
    tool: 'canvas_commands',
    status: 'success',
    data: {
      source: 'agent',
      canvasId: args.canvasId,
      commands,
    },
  });
}

// ==================== Knowledge Operations ====================

async function executeReadSource(args: {
  sourceId: string;
  canvasId: string;
}): Promise<string> {
  const node = getCanvasStore(args.canvasId).readNode(args.sourceId);
  if (!node) {
    return JSON.stringify({
      error: `Node ${args.sourceId} not found in canvas ${args.canvasId}`,
    });
  }

  return JSON.stringify({
    sourceId: args.sourceId,
    type: node.type,
    title: node.title,
    src: node.src,
    content: node.content,
  });
}

async function executeSearchKnowledge(args: {
  query: string;
  canvasId: string;
}): Promise<string> {
  const store = getCanvasStore(args.canvasId);
  const canvas = store.read();
  if (!canvas) {
    return JSON.stringify({
      query: args.query,
      resultCount: 0,
      results: [],
    });
  }

  const queryLower = args.query.toLowerCase();
  const allNodes = (canvas.state.nodes ?? []) as Array<Record<string, unknown>>;

  const matches: Array<{
    nodeId: string;
    parentId?: unknown;
    type: string;
    title: string | null;
    src: string | null;
    content: string;
    metadata: Record<string, unknown>;
  }> = [];

  for (const n of allNodes) {
    const nodeId = typeof n.id === 'string' ? n.id : '';
    if (!nodeId) continue;
    const nodeContent = store.readNode(nodeId);
    if (!nodeContent) continue;

    const titleMatch = nodeContent.title?.toLowerCase().includes(queryLower);
    const contentMatch = nodeContent.content
      ?.toLowerCase()
      .includes(queryLower);
    let keywordMatch = false;
    const meta = nodeContent.metadata as Record<string, unknown>;
    if (meta && Array.isArray(meta.keywords)) {
      keywordMatch = meta.keywords.some(
        (k) => typeof k === 'string' && k.toLowerCase().includes(queryLower),
      );
    }
    if (titleMatch || contentMatch || keywordMatch) {
      matches.push({
        nodeId,
        parentId: n.parentId,
        type: nodeContent.type,
        title: nodeContent.title ?? null,
        src: nodeContent.src ?? null,
        content: nodeContent.content,
        metadata: meta ?? {},
      });
    }
  }

  const results = matches.slice(0, 10).map((m) => {
    const preview = extractPreviewFromParsed(m.metadata, m.content);
    return {
      sourceId: m.nodeId,
      nodeId: m.nodeId,
      parentId: m.parentId,
      type: m.type,
      title: m.title,
      src: m.src,
      ...preview,
    };
  });

  return JSON.stringify({
    query: args.query,
    resultCount: results.length,
    results,
  });
}

async function executeIngestContent(args: {
  canvasId: string;
  nodeId: string;
}): Promise<string> {
  const canvas = getCanvasStore(args.canvasId).read();
  if (!canvas) {
    return JSON.stringify({ error: `Canvas ${args.canvasId} not found` });
  }

  const nodes = (canvas.state.nodes ?? []) as Array<Record<string, unknown>>;
  const node = nodes.find((n) => n.id === args.nodeId);
  if (!node) {
    return JSON.stringify({ error: `Node ${args.nodeId} not found` });
  }

  const data = node.data as Record<string, unknown> | undefined;
  const type = (data?.type as string) ?? (node.type as string);
  const dispatcher = getPreprocessDispatcher();

  const result = await dispatcher.preprocess({
    canvasId: args.canvasId,
    nodeId: args.nodeId,
    nodeType: type as CanvasNodeKind,
    trigger: 'manual',
    snapshot: {
      title: data?.label as string | undefined,
      content: data?.content as string | undefined,
      src: data?.src as string | undefined,
      sourceId: data?.sourceId as string | undefined,
    },
    options: { allowLLM: false },
  });

  // If no source was persisted (image/frame/video or extraction failure),
  // report clearly to the agent so it doesn't misinterpret success.
  const sourceId = result.persistence?.sourceId;
  const errors = result.diagnostics
    .filter((d) => d.level === 'error')
    .map((d) => `${d.code}: ${d.message}`);
  const errorString = errors.length > 0 ? errors.join('; ') : undefined;

  if (!sourceId && result.success) {
    return JSON.stringify({
      sourceId: null,
      success: true,
      title: result.extracted?.title,
      note: `Node type '${type}' does not persist to the knowledge base`,
    });
  }

  return JSON.stringify({
    sourceId: sourceId ?? null,
    success: result.success,
    title: result.extracted?.title,
    error: errorString,
  });
}

// ==================== Main Executor ====================

/**
 * Execute a tool call and return the result as a string.
 *
 * @param name Tool name
 * @param args Validated tool arguments
 * @returns Result string (typically JSON)
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context?: { mode?: AgentMode; canvasId?: string },
): Promise<string> {
  const resolveCanvasArgs = <T extends Record<string, unknown>>(
    value: T,
  ): (T & { canvasId: string }) | null => {
    const canvasId =
      typeof value.canvasId === 'string' && value.canvasId.trim().length > 0
        ? value.canvasId
        : context?.canvasId;
    if (!canvasId) return null;
    return { ...value, canvasId };
  };

  switch (name) {
    case 'web_search':
      return executeWebSearch(args as Parameters<typeof executeWebSearch>[0]);
    case 'get_node_detail': {
      const resolvedArgs = resolveCanvasArgs(args);
      if (!resolvedArgs) {
        return JSON.stringify({
          error: 'canvasId is required for get_node_detail',
        });
      }
      return executeGetNodeDetail(
        resolvedArgs as Parameters<typeof executeGetNodeDetail>[0],
      );
    }
    case 'get_canvas_state': {
      const resolvedArgs = resolveCanvasArgs(args);
      if (!resolvedArgs) {
        return JSON.stringify({
          error: 'canvasId is required for get_canvas_state',
        });
      }
      return executeGetCanvasState(
        resolvedArgs as Parameters<typeof executeGetCanvasState>[0],
      );
    }
    case 'canvas_commands': {
      const resolvedArgs = resolveCanvasArgs(args);
      if (!resolvedArgs) {
        return JSON.stringify({
          tool: 'canvas_commands',
          status: 'error',
          error: 'canvasId is required for canvas_commands',
        });
      }
      return executeCanvasCommands(
        resolvedArgs as Parameters<typeof executeCanvasCommands>[0],
        context,
      );
    }
    case 'read_source': {
      const resolvedArgs = resolveCanvasArgs(args);
      if (!resolvedArgs) {
        return JSON.stringify({
          error: 'canvasId is required for read_source',
        });
      }
      return executeReadSource(
        resolvedArgs as Parameters<typeof executeReadSource>[0],
      );
    }
    case 'search_knowledge': {
      const resolvedArgs = resolveCanvasArgs(args);
      if (!resolvedArgs) {
        return JSON.stringify({
          error: 'canvasId is required for search_knowledge',
        });
      }
      return executeSearchKnowledge(
        resolvedArgs as Parameters<typeof executeSearchKnowledge>[0],
      );
    }
    case 'ingest_content': {
      const resolvedArgs = resolveCanvasArgs(args);
      if (!resolvedArgs) {
        return JSON.stringify({
          error: 'canvasId is required for ingest_content',
        });
      }
      return executeIngestContent(
        resolvedArgs as Parameters<typeof executeIngestContent>[0],
      );
    }
    case 'use_skill': {
      const skillId =
        typeof args.skillId === 'string' ? args.skillId.trim() : '';
      const skill = SKILL_REGISTRY.get(skillId);
      if (!skill) {
        const available = [...SKILL_REGISTRY.keys()];
        return JSON.stringify({
          error: `Unknown skill: "${skillId}"`,
          available,
        });
      }
      return skill.content;
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
