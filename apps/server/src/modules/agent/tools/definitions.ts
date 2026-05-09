/**
 * Tool Definitions for the Unified Agent
 *
 * All tools the AI can call across ask and operate modes.
 * Each tool is a pi-ai Tool with a TypeBox schema for validation.
 *
 * Definitions here are pure schema + description pairs. The runnable
 * `AgentTool` form (with `execute` closures bound to a request-scoped
 * `canvasId`) is built by `buildToolsForMode` in `./index.ts`.
 *
 * Building-block schemas (node / edge / command primitives) live under
 * `./schemas/`. This file only composes them into the per-tool
 * `*ParamsSchema` objects and pairs each with a description.
 */

import { Type } from '@earendil-works/pi-ai';

import { AgentCanvasCommandSchema } from './schemas/command.js';
import { OptionalCanvasIdField } from './schemas/common.js';

import type { Tool } from '@earendil-works/pi-ai';

/**
 * Definition shape we author here: a pi-ai `Tool` plus a UI-facing
 * `label`. The runnable `execute` field is added later by `buildToolsForMode`,
 * which closes over the request-scoped `canvasId`.
 */
export interface ToolDefinition extends Tool {
  /** Human-readable label, surfaced to pi-agent-core's UI hooks. */
  label: string;
}

// ==================== Web Search ====================

export const webSearchParamsSchema = Type.Object({
  query: Type.String({ description: 'The search query keywords' }),
  max_results: Type.Optional(
    Type.Number({
      description: 'Maximum number of results (1-10). Default: 5.',
      minimum: 1,
      maximum: 10,
    }),
  ),
  search_depth: Type.Optional(
    Type.Union([Type.Literal('basic'), Type.Literal('advanced')], {
      description: "Search depth. Default: 'basic'.",
    }),
  ),
  include_answer: Type.Optional(
    Type.Boolean({
      description: 'Whether to include Tavily answer summary. Default: true.',
    }),
  ),
});

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  label: 'Web Search',
  description:
    'Search the internet for up-to-date facts, documentation, or news using Tavily.',
  parameters: webSearchParamsSchema,
};

// ==================== Canvas Read-Only Tools ====================

export const getNodeDetailParamsSchema = Type.Object({
  nodeId: Type.String({ description: 'The ID of the canvas node to read' }),
  ...OptionalCanvasIdField,
});

export const getNodeDetailTool: ToolDefinition = {
  name: 'get_node_detail',
  label: 'Get Node Detail',
  description:
    'Get the full content and metadata of a specific canvas node by its ID.',
  parameters: getNodeDetailParamsSchema,
};

export const getCanvasStateParamsSchema = Type.Object({
  ...OptionalCanvasIdField,
});

export const getCanvasStateTool: ToolDefinition = {
  name: 'get_canvas_state',
  label: 'Get Canvas State',
  description:
    'Get a summary of the current canvas state including all nodes, edges, and frames.',
  parameters: getCanvasStateParamsSchema,
};

// ==================== Canvas Commands ====================

export const canvasCommandsParamsSchema = Type.Object({
  ...OptionalCanvasIdField,
  commands: Type.Array(AgentCanvasCommandSchema, {
    description: 'Array of canvas commands to execute as a batch',
  }),
});

export const canvasCommandsTool: ToolDefinition = {
  name: 'canvas_commands',
  label: 'Canvas Commands',
  description: `Execute a batch of canvas commands atomically. All commands in a single call are applied as one undo step.

## Command types

- CREATE_NODES — create one or more nodes. Set skipAutoLayout: true when you provide explicit positions.
- CREATE_QUESTION — create a question node on the canvas. The agent uses this to pose follow-up questions or prompts to the user. Provide the question text as content.
- DELETE_NODES — delete nodes by ID (also removes incident edges)
- MERGE_NODE_DATA — shallow-merge a patch into node data (label, content, style). Style supports accent (hex color for top border stripe, shared palette with edge strokes) and backgroundColor on all node types; text-related style fields only apply to text nodes.
- SET_NODE_PARENT — move nodes into/out of a frame
- DISSOLVE_FRAME — ungroup a frame, keeping child nodes
- SET_NODE_GEOMETRY — set position and/or size of nodes
- REORDER_NODES — change z-order of nodes
- CONNECT_NODES — create edges between nodes (with optional style)
- DISCONNECT_EDGES — remove edges by ID or source/target pair
- SET_EDGE_STYLE — update visual style of existing edges
- ALIGN_NODES — align selected nodes along an axis
- DISTRIBUTE_NODES — evenly distribute selected nodes
- AUTO_LAYOUT — run force-directed layout on canvas or frame

## ID conventions

- Node IDs: "node-<uuid>" (use crypto.randomUUID())
- Edge IDs: "edge-<uuid>"
- When a later command in the batch needs to reference a node created by an earlier command, provide an explicit id in CREATE_NODES.

## Common patterns

Group into frame: CREATE_NODES (frame) + SET_NODE_PARENT (children → frame)
Create and connect: CREATE_NODES (multiple nodes with explicit ids) + CONNECT_NODES (edges referencing those ids)`,
  parameters: canvasCommandsParamsSchema,
};

// ==================== Content Ingestion Tools ====================

export const ingestContentParamsSchema = Type.Object({
  ...OptionalCanvasIdField,
  nodeId: Type.String({
    description: 'The node ID to trigger ingestion for',
  }),
});

export const ingestContentTool: ToolDefinition = {
  name: 'ingest_content',
  label: 'Ingest Content',
  description:
    'Trigger content ingestion for a canvas node, loading its web/PDF content into the per-canvas content store.',
  parameters: ingestContentParamsSchema,
};

// ==================== Canvas Filesystem Tools ====================
//
// Tool names and parameter shapes mirror pi-coding-agent / Claude Code
// (`read`, `grep`, `find`, `ls`) so any model already trained on those
// signatures recognizes them. The cwd model is also pi-style: paths
// are relative to the active workspace root, and when the agent omits
// `path` (where Optional) the operation defaults to the current
// canvas folder. To address a different canvas, pass an explicit
// `path: "<canvasId>/..."`.
//
// See `handlers/canvas-fs.ts` and `handlers/read.ts` for sandbox +
// enrichment details. Shared sandbox primitives live in
// `handlers/sandbox.ts`.

export const readParamsSchema = Type.Object({
  path: Type.String({
    description:
      'File path relative to the workspace root, e.g. "<canvasId>/canvas.json" or "<canvasId>/nodes/<nodeId>.md".',
  }),
  offset: Type.Optional(
    Type.Number({
      description: '1-indexed line number to start reading from. Default: 1.',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        'Maximum number of lines to read. Default: capped by the 2000-line / 50 KB output budget.',
    }),
  ),
});

export const readTool: ToolDefinition = {
  name: 'read',
  label: 'Read',
  description: `Read the contents of a single text file under the workspace root. Returns JSON: { path, startLine, endLine, totalLines, truncated, nextOffset?, content }. Output is truncated to 2000 lines or 50 KB, whichever is hit first; when truncated, "nextOffset" tells you the offset to use to continue. Binary files (images, archives) are rejected with an error — for node images use get_node_detail and inspect the "src" field. The read tool returns raw file contents only; for node metadata (label, position, parent) chain into get_node_detail.`,
  parameters: readParamsSchema,
};

export const grepParamsSchema = Type.Object({
  pattern: Type.String({
    description:
      'Search pattern. Treated as a regular expression by default; set literal=true for plain string matching.',
  }),
  path: Type.Optional(
    Type.String({
      description:
        'Directory or file to search, relative to the workspace root. Default: the current canvas folder. Pass "<canvasId>/nodes" to target a specific canvas, or "." for the entire workspace.',
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description:
        'Filter files by glob pattern, e.g. "*.md", "nodes/*.md", "**/*.json". Supports *, **, ?, and {a,b} alternation.',
    }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: 'Case-insensitive search. Default: false.' }),
  ),
  literal: Type.Optional(
    Type.Boolean({
      description:
        'Treat pattern as a literal string instead of a regex. Default: false.',
    }),
  ),
  context: Type.Optional(
    Type.Number({
      description:
        'Number of lines to include before and after each match. Default: 0.',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of matches to return. Default: 100.',
    }),
  ),
});

export const grepTool: ToolDefinition = {
  name: 'grep',
  label: 'Grep',
  description: `Search file contents for a pattern. Paths are relative to the workspace root; when omitted, search defaults to the current canvas folder. Returns JSON with matching paths, line numbers, and matched text. Skips .history/, .git/, and node_modules/. When a match is in <canvasId>/nodes/<nodeId>.md, the result also includes canvasId, nodeId, label, and nodeType — chain straight into get_node_detail or canvas_commands without a second lookup. Output is capped at 100 matches by default.`,
  parameters: grepParamsSchema,
};

export const findParamsSchema = Type.Object({
  pattern: Type.String({
    description:
      'Glob pattern to match files, e.g. "*.md", "nodes/*.md", "**/*.json". Patterns without "/" auto-match at any depth.',
  }),
  path: Type.Optional(
    Type.String({
      description:
        'Directory to search, relative to the workspace root. Default: the current canvas folder.',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of results to return. Default: 1000.',
    }),
  ),
});

export const findTool: ToolDefinition = {
  name: 'find',
  label: 'Find',
  description: `Find files by glob pattern. Paths are relative to the workspace root; when omitted, search defaults to the current canvas folder. Returns JSON with matching paths. When a result is <canvasId>/nodes/<nodeId>.md, the entry also includes canvasId, nodeId, label, and nodeType. Skips .history/, .git/, and node_modules/.`,
  parameters: findParamsSchema,
};

export const lsParamsSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        'Directory to list, relative to the workspace root. Default: the current canvas folder.',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum entries to return. Default: 500.',
    }),
  ),
});

export const lsTool: ToolDefinition = {
  name: 'ls',
  label: 'Ls',
  description: `List directory contents under the workspace root. When path is omitted, lists the current canvas folder. Returns JSON with entries sorted alphabetically; directories carry a trailing "/". A canvas folder typically contains canvas.json plus subdirectories such as nodes/, artifacts/, and memory/.`,
  parameters: lsParamsSchema,
};

// ==================== Skill Tool ====================

export const useSkillParamsSchema = Type.Object({
  skillId: Type.String({
    description:
      'The skill ID to load. See the skill catalogue in the system prompt for available IDs.',
  }),
});

export const useSkillTool: ToolDefinition = {
  name: 'use_skill',
  label: 'Use Skill',
  description:
    'Load detailed guidance for a specific skill before executing complex canvas operations. Call this when you need step-by-step guidance for tasks like building flowcharts, creating structured layouts, synthesizing nodes, etc. The skill content will be returned as the tool result.',
  parameters: useSkillParamsSchema,
};

// ==================== Tool Sets by Mode ====================

/**
 * Tools available in chat mode.
 * Includes read-only canvas/content access so the agent can
 * lazily fetch full content of selected nodes on demand.
 */
export const chatTools: ToolDefinition[] = [
  webSearchTool,
  getCanvasStateTool,
  getNodeDetailTool,
  readTool,
  grepTool,
  findTool,
  lsTool,
  useSkillTool,
  ingestContentTool,
];

/**
 * Tools available in operate mode.
 * Full set of canvas manipulation tools for intent execution.
 */
export const operateTools: ToolDefinition[] = [
  webSearchTool,
  getCanvasStateTool,
  getNodeDetailTool,
  readTool,
  grepTool,
  findTool,
  lsTool,
  canvasCommandsTool,
  useSkillTool,
  ingestContentTool,
];
