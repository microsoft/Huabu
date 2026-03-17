/**
 * Tool Executor
 *
 * Implements the actual execution of each tool. Takes a tool call from the LLM
 * and returns a text result to be fed back as a toolResult message.
 */

import {
  readCanvas,
  writeCanvas,
  type CanvasFile,
} from '../../canvas/canvas.filestore.js';
import { getCanvasOperationService } from '../../canvas/canvas.operation.js';
import { getIngestService } from '../../knowledge/index.js';
import { getKnowledgeRepository } from '../../knowledge/knowledge.repository.js';

import type { NodeData } from '@sediment/shared';
// TODO: spilt into multiple files as it grows, e.g. webSearchTool.ts, canvasTool.ts, knowledgeTool.ts, etc.
// TODO: add more canvas operations as needed, e.g. updateNode, deleteNode, connectNodes, etc.
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

async function executeCreateNode(args: {
  canvasId: string;
  nodeType: string;
  label?: string;
  content?: string;
  src?: string;
  position?: { x: number; y: number };
}): Promise<string> {
  const ops = getCanvasOperationService();

  const nodeType = args.nodeType as
    | 'note'
    | 'text'
    | 'web'
    | 'image'
    | 'pdf'
    | 'video';

  const result = await ops.createNode({
    canvasId: args.canvasId,
    position: args.position ?? { x: 0, y: 0 },
    data: {
      type: nodeType,
      label: args.label ?? '',
      content: args.content,
      src: args.src,
    } as NodeData,
  });

  return JSON.stringify({
    nodeId: result.nodeId,
    canvasId: args.canvasId,
    type: args.nodeType,
    label: args.label,
  });
}

async function executeUpdateNode(args: {
  canvasId: string;
  nodeId: string;
  label?: string;
  content?: string;
}): Promise<string> {
  const ops = getCanvasOperationService();
  const patch: Record<string, unknown> = {};
  if (args.label !== undefined) patch.label = args.label;
  if (args.content !== undefined) patch.content = args.content;

  await ops.updateNodeData(args.canvasId, args.nodeId, patch);

  return JSON.stringify({ success: true, nodeId: args.nodeId });
}

async function executeDeleteNodes(args: {
  canvasId: string;
  nodeIds: string[];
}): Promise<string> {
  const canvas = readCanvas(args.canvasId);
  if (!canvas) {
    return JSON.stringify({ error: `Canvas ${args.canvasId} not found` });
  }

  const nodes = (canvas.state.nodes ?? []) as Array<Record<string, unknown>>;
  const edges = (canvas.state.edges ?? []) as Array<Record<string, unknown>>;

  const idsToDelete = new Set(args.nodeIds);
  const remainingNodes = nodes.filter((n) => !idsToDelete.has(n.id as string));
  const remainingEdges = edges.filter(
    (e) =>
      !idsToDelete.has(e.source as string) &&
      !idsToDelete.has(e.target as string),
  );

  const canvasFile: CanvasFile = {
    canvasId: args.canvasId,
    title: canvas.title,
    version: canvas.version + 1,
    state: { nodes: remainingNodes, edges: remainingEdges },
    createdAt: canvas.createdAt,
    updatedAt: Date.now(),
  };
  writeCanvas(canvasFile);

  return JSON.stringify({
    success: true,
    deletedCount: args.nodeIds.length,
  });
}

async function executeConnectNodes(args: {
  canvasId: string;
  sourceId: string;
  targetId: string;
}): Promise<string> {
  const ops = getCanvasOperationService();
  const result = await ops.createEdge({
    canvasId: args.canvasId,
    sourceNodeId: args.sourceId,
    targetNodeId: args.targetId,
  });
  return JSON.stringify({
    edgeId: result.edgeId,
    sourceId: args.sourceId,
    targetId: args.targetId,
  });
}

async function executeDisconnectNodes(args: {
  canvasId: string;
  sourceId: string;
  targetId: string;
}): Promise<string> {
  const canvas = readCanvas(args.canvasId);
  if (!canvas) {
    return JSON.stringify({ error: `Canvas ${args.canvasId} not found` });
  }

  const nodes = (canvas.state.nodes ?? []) as Array<Record<string, unknown>>;
  const edges = (canvas.state.edges ?? []) as Array<Record<string, unknown>>;

  const remaining = edges.filter(
    (e) => !(e.source === args.sourceId && e.target === args.targetId),
  );

  const canvasFile: CanvasFile = {
    canvasId: args.canvasId,
    title: canvas.title,
    version: canvas.version + 1,
    state: { nodes, edges: remaining },
    createdAt: canvas.createdAt,
    updatedAt: Date.now(),
  };
  writeCanvas(canvasFile);

  return JSON.stringify({ success: true });
}

async function executeCreateFrame(args: {
  canvasId: string;
  nodeIds: string[];
  frameLabel?: string;
}): Promise<string> {
  const ops = getCanvasOperationService();
  const result = await ops.createFrame({
    canvasId: args.canvasId,
    label: args.frameLabel ?? 'Frame',
    childNodeIds: args.nodeIds,
    position: { x: 0, y: 0 },
  });
  return JSON.stringify({ frameId: result.nodeId });
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
  const ingestService = await getIngestService();

  if (type === 'note' || type === 'text' || type === 'web') {
    const outcome = await ingestService.ingestCanvasNode({
      nodeId: args.nodeId,
      type: type as 'note' | 'text' | 'web',
      title: data?.label as string | undefined,
      content: data?.content as string | undefined,
      src: data?.src as string | undefined,
      existingSourceId: data?.sourceId as string | undefined,
    });

    // Update the node with the sourceId
    if (outcome.sourceId) {
      const ops = getCanvasOperationService();
      await ops.updateNodeData(args.canvasId, args.nodeId, {
        sourceId: outcome.sourceId,
      });
    }

    return JSON.stringify({
      sourceId: outcome.sourceId,
      success: outcome.success,
      title: outcome.title,
      error: outcome.error,
    });
  }

  return JSON.stringify({
    error: `Ingestion not supported for node type: ${type}`,
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
    case 'create_node':
      return executeCreateNode(args as Parameters<typeof executeCreateNode>[0]);
    case 'update_node':
      return executeUpdateNode(args as Parameters<typeof executeUpdateNode>[0]);
    case 'delete_nodes':
      return executeDeleteNodes(
        args as Parameters<typeof executeDeleteNodes>[0],
      );
    case 'connect_nodes':
      return executeConnectNodes(
        args as Parameters<typeof executeConnectNodes>[0],
      );
    case 'disconnect_nodes':
      return executeDisconnectNodes(
        args as Parameters<typeof executeDisconnectNodes>[0],
      );
    case 'create_frame':
      return executeCreateFrame(
        args as Parameters<typeof executeCreateFrame>[0],
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
