/**
 * Tool Executor
 *
 * Implements the actual execution of each tool. Takes a tool call from the LLM
 * and returns a text result to be fed back as a toolResult message.
 */

import { readCanvas } from '../../canvas/canvas.filestore.js';
import { getKnowledgeRepository } from '../../knowledge/knowledge.repository.js';
import { getPreprocessDispatcher } from '../../preprocessing/index.js';

import type { AgentMode, CanvasNodeKind, NodeOrigin } from '@sediment/shared';

// ==================== Origin Helper ====================

function agentModeToOrigin(mode?: AgentMode): NodeOrigin {
  switch (mode) {
    case 'research':
      return { type: 'ai-research' };
    default:
      return { type: 'ai-operate' };
  }
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

// ==================== Canvas Operations ====================

async function executeGetNodeDetail(args: {
  nodeId: string;
  canvasId: string;
}): Promise<string> {
  const canvas = readCanvas(args.canvasId);
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
  const sourceId = data?.sourceId as string | undefined;

  // If the node has a sourceId, load content from knowledge base
  let content = data?.content as string | undefined;
  if (sourceId) {
    const repo = await getKnowledgeRepository();
    const source = repo.findSourceById(sourceId);
    if (source) {
      content = source.content;
    }
  }

  return JSON.stringify({
    id: node.id,
    type: node.type ?? data?.type,
    label: data?.label,
    content,
    src: data?.src,
    sourceId,
    position: node.position,
    width: node.width,
    height: node.height,
    parentId: node.parentId,
  });
}

async function executeGetCanvasState(args: {
  canvasId: string;
}): Promise<string> {
  const canvas = readCanvas(args.canvasId);
  if (!canvas) {
    return JSON.stringify({ error: `Canvas ${args.canvasId} not found` });
  }

  const nodes = (canvas.state.nodes ?? []) as Array<Record<string, unknown>>;
  const edges = (canvas.state.edges ?? []) as Array<Record<string, unknown>>;

  const summary = nodes.map((n) => {
    const data = n.data as Record<string, unknown> | undefined;
    const content = data?.content as string | undefined;
    return {
      id: n.id,
      type: n.type ?? data?.type,
      label: data?.label,
      snippet: content ? content.slice(0, 120) : undefined,
      src: data?.src,
      parentId: n.parentId,
    };
  });

  const edgeSummary = edges.map((e) => ({
    source: e.source,
    target: e.target,
  }));

  return JSON.stringify({
    canvasId: args.canvasId,
    version: canvas.version,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: summary,
    edges: edgeSummary,
  });
}

// ==================== Canvas Commands ====================

/**
 * Validate and prepare a canvas_commands batch for forwarding to the web client.
 * Injects origin into CREATE_NODES commands. Does NOT apply the commands.
 */
async function executeCanvasCommands(
  args: {
    canvasId: string;
    commands: Array<Record<string, unknown>>;
  },
  context?: { mode?: AgentMode },
): Promise<string> {
  const origin = agentModeToOrigin(context?.mode);
  const commands = args.commands.map((cmd) => {
    if (cmd.type === 'CREATE_NODES') {
      const nodes = cmd.nodes as Array<Record<string, unknown>>;
      return {
        ...cmd,
        nodes: nodes.map((node) => ({
          ...node,
          data: {
            ...(node.data as Record<string, unknown> | undefined),
            origin,
          },
        })),
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

async function executeReadSource(args: { sourceId: string }): Promise<string> {
  const repo = await getKnowledgeRepository();
  const source = repo.findSourceById(args.sourceId);
  if (!source) {
    return JSON.stringify({ error: `Source ${args.sourceId} not found` });
  }

  return JSON.stringify({
    sourceId: source.sourceId,
    type: source.type,
    title: source.title,
    src: source.src,
    content: source.content,
  });
}

async function executeSearchKnowledge(args: {
  query: string;
}): Promise<string> {
  const repo = await getKnowledgeRepository();
  const allSources = repo.findAllSources();

  const queryLower = args.query.toLowerCase();
  const matches = allSources.filter((s) => {
    const titleMatch = s.title?.toLowerCase().includes(queryLower);
    const contentMatch = s.content?.toLowerCase().includes(queryLower);
    return titleMatch || contentMatch;
  });

  const results = matches.slice(0, 10).map((s) => ({
    sourceId: s.sourceId,
    type: s.type,
    title: s.title,
    src: s.src,
    snippet: s.content?.slice(0, 200),
  }));

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
  const canvas = readCanvas(args.canvasId);
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
  const dispatcher = await getPreprocessDispatcher();

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
  context?: { mode?: AgentMode },
): Promise<string> {
  switch (name) {
    case 'web_search':
      return executeWebSearch(args as Parameters<typeof executeWebSearch>[0]);
    case 'get_node_detail':
      return executeGetNodeDetail(
        args as Parameters<typeof executeGetNodeDetail>[0],
      );
    case 'get_canvas_state':
      return executeGetCanvasState(
        args as Parameters<typeof executeGetCanvasState>[0],
      );
    case 'canvas_commands':
      return executeCanvasCommands(
        args as Parameters<typeof executeCanvasCommands>[0],
        context,
      );
    case 'read_source':
      return executeReadSource(args as Parameters<typeof executeReadSource>[0]);
    case 'search_knowledge':
      return executeSearchKnowledge(
        args as Parameters<typeof executeSearchKnowledge>[0],
      );
    case 'ingest_content':
      return executeIngestContent(
        args as Parameters<typeof executeIngestContent>[0],
      );
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
