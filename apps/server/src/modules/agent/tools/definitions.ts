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
//
// Two-tool surface for "understand the canvas without mutating it":
//
//   - `get_canvas_outline`  — one-shot map of the whole canvas
//     (geometry + edges + spatial clusters). Call once per canvas to
//     orient yourself.
//   - `inspect_nodes`        — predicate-driven node lookup (attribute /
//     spatial / topological), returning each match with full geometry +
//     style + per-predicate derived fields.
//
// Boundary with `read`: anything in the node markdown frontmatter
// (label, type, src, content, summary, keywords) lives in
// `<canvasId>/nodes/<nodeId>.md` and is owned by `read`. These two
// tools own everything in `canvas.json` (position/size/parent/style)
// plus derived spatial/topological metadata.

export const getCanvasOutlineParamsSchema = Type.Object({
  ...OptionalCanvasIdField,
  includePreviews: Type.Optional(
    Type.Boolean({
      description:
        'Attach a short text preview (summary / keywords / first 120 chars) to every node. Default: false. Skip unless you need a quick overview of contents — for full text use read on "<canvasId>/nodes/<nodeId>.md".',
    }),
  ),
  includeStyle: Type.Optional(
    Type.Boolean({
      description:
        "Attach each node's visual style (accent / backgroundColor / text styling). Default: false. Set true only for visual / styling tasks.",
    }),
  ),
});

export const getCanvasOutlineTool: ToolDefinition = {
  name: 'get_canvas_outline',
  label: 'Get Canvas Outline',
  description: `One-shot map of the whole canvas. Returns JSON: { canvasId, version, bbox, nodes: [{ id, type, label, parentId, position, width, height, style?, preview? }], edges: [{ id?, source, target, style? }], spatial: { clusters: [{ frameId?, frameLabel?, nodeIds (reading-order), arrangement }] } }. Call this once when you enter a canvas to orient yourself; later, drill in with inspect_nodes / read. Frame nodes are entries in \`nodes\` with type='frame' — group by parentId to recover the frame tree. Isolated nodes = all node ids minus the union of cluster nodeIds. \`preview\` and \`style\` are opt-in via the matching flags. For full content of any node, call read on "<canvasId>/nodes/<nodeId>.md".`,
  parameters: getCanvasOutlineParamsSchema,
};

export const inspectNodesParamsSchema = Type.Object({
  ...OptionalCanvasIdField,
  // ── Attribute predicates ──
  ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Match these node IDs explicitly. Combinable with other filters.',
    }),
  ),
  byType: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description:
        'Filter by node type, e.g. "image" or ["image","pdf"]. Common types: note, text, image, pdf, web, video, frame, question.',
    }),
  ),
  byParent: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        'Filter by parent (frame) ID. Pass null to match top-level nodes only.',
    }),
  ),
  labelPattern: Type.Optional(
    Type.String({
      description:
        'Regex matched against the node label (data.label). For full-text search inside node bodies use the grep tool instead.',
    }),
  ),
  // ── Spatial predicates ──
  inRect: Type.Optional(
    Type.Object(
      {
        x: Type.Number(),
        y: Type.Number(),
        width: Type.Number(),
        height: Type.Number(),
      },
      {
        description:
          'Match nodes whose center lies inside this rectangle (absolute canvas coordinates).',
      },
    ),
  ),
  nearNode: Type.Optional(
    Type.Object(
      {
        id: Type.String(),
        maxDistance: Type.Optional(Type.Number()),
        maxCount: Type.Optional(Type.Number()),
        sameParent: Type.Optional(Type.Boolean()),
      },
      {
        description:
          "Find nodes near the given node by edge-to-edge distance. Each match carries derived `distance`, `centerDistance`, `direction`. `sameParent` restricts to the target's siblings.",
      },
    ),
  ),
  nearPoint: Type.Optional(
    Type.Object(
      {
        x: Type.Number(),
        y: Type.Number(),
        maxDistance: Type.Optional(Type.Number()),
        maxCount: Type.Optional(Type.Number()),
      },
      {
        description:
          'Find nodes near a canvas point. Each match carries derived `distance`, `centerDistance`, `direction`.',
      },
    ),
  ),
  inSameClusterAs: Type.Optional(
    Type.String({
      description:
        'Return the other nodes in the same spatial cluster as this node (excluding the node itself). Each match carries `clusterId`.',
    }),
  ),
  // ── Topological predicates ──
  connectedTo: Type.Optional(
    Type.Object(
      {
        id: Type.String(),
        depth: Type.Optional(
          Type.Union([Type.Literal(1), Type.Literal(2)], {
            description: 'Hop depth, 1 (direct neighbors) or 2. Default: 1.',
          }),
        ),
      },
      {
        description:
          'Find nodes connected to the given node via edges (the target node itself is excluded from results). Each match carries `edgeIds` and `hops`.',
      },
    ),
  ),
  // ── Output controls ──
  sort: Type.Optional(
    Type.Union(
      [
        Type.Literal('distance'),
        Type.Literal('reading-order'),
        Type.Literal('area'),
      ],
      {
        description:
          'Result ordering. Defaults to `distance` when nearNode/nearPoint is used, otherwise insertion order.',
      },
    ),
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of nodes to return. Default: 50.',
    }),
  ),
});

export const inspectNodesTool: ToolDefinition = {
  name: 'inspect_nodes',
  label: 'Inspect Nodes',
  description: `Find canvas nodes by predicate (attribute / spatial / topological) and return each match with full geometry + visual style + derived fields. Predicates AND together. **Always supply at least one predicate** — calling with no predicates returns every node, which is wasteful; for whole-canvas reads use get_canvas_outline instead. Returns JSON: { count, truncated, arrangement?, nodes: [{ id, type, label, parentId, position, width, height, style?, distance?, centerDistance?, direction?, edgeIds?, hops?, clusterId? }] }. When truncated:true, raise limit or refine your query. Note on connectedTo: the target node itself is excluded from results. Use this for "where is X?" (ids), "what's near X?" (nearNode), "what connects to X?" (connectedTo), "what's in this region?" (inRect), or any combination. For full node content (label/text/summary/keywords) call read on "<canvasId>/nodes/<nodeId>.md" — only canvas.json fields are surfaced here.`,
  parameters: inspectNodesParamsSchema,
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
// See `handlers/fs-search.ts` and `handlers/fs-read.ts` for sandbox +
// enrichment details. Shared sandbox primitives live in
// `handlers/fs-sandbox.ts`.

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
  description: `Read the contents of a **single** text file under the workspace root — no globs (use find to enumerate, then read each match). Returns JSON: { path, startLine, endLine, totalLines, truncated, nextOffset?, content, frontmatter? }. Output is truncated to 2000 lines or 50 KB, whichever is hit first; when truncated:true, nextOffset is the 1-indexed line number of the next unread line — pass it as the next offset to keep paging. Binary files (images, archives) are rejected with an error.

Readable file types include: "<canvasId>/canvas.json" (geometry, edges); "<canvasId>/nodes/<nodeId>.md" (per-node markdown with frontmatter); "<canvasId>/chat/<thread>.json" (saved chat threads); "<canvasId>/intent.json" / "<canvasId>/events.jsonl" (intent + event logs); "<canvasId>/memory/*.md" (long-form memory); "<canvasId>/artifacts/*" metadata. Sources / images / pdfs are stored as binary under artifacts/ and are not readable here.

When the file begins with a YAML frontmatter block ("---" fences), the parsed frontmatter is also returned as a structured object so you don't have to parse YAML yourself. For node files the frontmatter object includes: label, type, src?, summary?, keywords?.

Boundary: a node's textual attributes (label, content, type, src, summary, keywords) live in "<canvasId>/nodes/<nodeId>.md" — read them here. A node's canvas placement (position, size, parent, style) lives in canvas.json — call inspect_nodes({ ids: ["<nodeId>"] }) instead.`,
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
  description: `Search file contents for a pattern. Paths are relative to the workspace root; when omitted, search defaults to the current canvas folder. Returns JSON with matching paths, line numbers, and matched text, plus a \`truncated\` flag (raise \`limit\` or refine the pattern when true). Skips .history/, .git/, and node_modules/. When a match is in <canvasId>/nodes/<nodeId>.md, the result also includes canvasId, nodeId, label, and nodeType — chain straight into read (for the rest of the file) or inspect_nodes / canvas_commands without a second lookup. Output is capped at 100 matches by default.`,
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
  description: `Find files by glob pattern. Paths are relative to the workspace root; when omitted, search defaults to the current canvas folder. Returns JSON with matching paths and a \`truncated\` flag (raise \`limit\` or narrow the pattern when true). When a result is <canvasId>/nodes/<nodeId>.md, the entry also includes canvasId, nodeId, label, and nodeType. Skips .history/, .git/, and node_modules/.`,
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
  description: `List directory contents under the workspace root. When path is omitted, lists the current canvas folder. Returns JSON with entries sorted alphabetically (directories carry a trailing "/") plus a \`truncated\` flag (raise \`limit\` when true). A canvas folder typically contains canvas.json plus subdirectories such as nodes/, artifacts/, and memory/.`,
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
  getCanvasOutlineTool,
  inspectNodesTool,
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
  getCanvasOutlineTool,
  inspectNodesTool,
  readTool,
  grepTool,
  findTool,
  lsTool,
  canvasCommandsTool,
  useSkillTool,
  ingestContentTool,
];
