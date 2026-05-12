/**
 * Tool Definitions for the Unified Agent
 *
 * All tools the AI can call across ask, operate, and annotation
 * scopes. Each tool is a pi-ai Tool with a TypeBox schema for
 * validation.
 *
 * Definitions here are pure schema + description pairs. The runnable
 * `AgentTool` form (with `execute` closures bound to a request-scoped
 * `canvasId`) is built by `buildToolsForScope` in `./index.ts`.
 *
 * Building-block schemas (node / edge / command primitives) live under
 * `./schemas/`. This file only composes them into the per-tool
 * `*ParamsSchema` objects and pairs each with a description.
 */

import { Type } from '@earendil-works/pi-ai';

import { AgentCanvasCommandSchema } from './schemas/command.js';
import {
  EdgeDirectionSchema,
  EdgeLineStyleSchema,
  EdgeLineTypeSchema,
} from './schemas/edge.js';

import type { ToolExecutionMode } from '@earendil-works/pi-agent-core';
import type { Tool } from '@earendil-works/pi-ai';

/**
 * Definition shape we author here: a pi-ai `Tool` plus a UI-facing
 * `label`. The runnable `execute` field is added later by `buildToolsForScope`,
 * which closes over the request-scoped `canvasId`.
 */
export interface ToolDefinition extends Tool {
  /** Human-readable label, surfaced to pi-agent-core's UI hooks. */
  label: string;
  /**
   * Optional per-tool execution mode override forwarded to pi-agent-core's
   * `AgentTool.executionMode`. Set `'sequential'` for tools whose batched
   * calls must preserve declared order (e.g. write tools where a later
   * call depends on an earlier call's effect, either server-side or via
   * client-side SSE apply ordering). When omitted, the agent's default
   * `toolExecution` mode applies. pi-agent-core falls back to a fully
   * serial batch as soon as **any** tool call in the batch is sequential.
   */
  executionMode?: ToolExecutionMode;
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
// Three-tool surface for "understand the canvas without mutating it":
//
//   - `get_canvas_outline`  — one-shot map of the whole canvas
//     (geometry + topology-only edges + spatial clusters). Call once
//     per canvas to orient yourself.
//   - `inspect_nodes`        — predicate-driven node lookup (attribute
//     / spatial / topological), returning each match with full
//     geometry + style + per-predicate derived fields.
//   - `inspect_edges`        — predicate-driven edge lookup (by id /
//     endpoints / EdgeStyle attributes). Call when you need edge
//     direction / line style / stroke — outline carries only
//     `{ id, source, target }` to keep the orient-yourself call lean.
//
// Boundary with `read`: anything in the node markdown frontmatter
// (label, type, src, content, summary, keywords) lives in
// `nodes/*.md` and is owned by `read`. The three canvas tools
// own everything in `canvas.json` (position/size/parent/style on
// nodes, EdgeStyle on edges) plus derived spatial/topological
// metadata.
//
// Every canvas tool is implicitly scoped to the current request's canvas
// — there is no `canvasId` argument.

export const getCanvasOutlineParamsSchema = Type.Object({
  includePreviews: Type.Optional(
    Type.Boolean({
      description:
        'Attach a short text preview (summary / keywords / first 120 chars) to every node. Default: false. Skip unless you need a quick overview of contents — for full text use read on "nodes/*.md".',
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
  description: `One-shot map of the whole canvas. Returns JSON: { canvasId, version, bbox, nodes: [{ id, type, label, parentId, position, width, height, style?, preview? }], edges: [{ id?, source, target }], spatial: { clusters: [{ frameId?, frameLabel?, nodeIds (reading-order), arrangement }] } }. Edges are topology-only here — for an edge's direction / line style / stroke / strokeWidth call \`inspect_edges\` instead. Call this once when you enter a canvas to orient yourself; later, drill in with inspect_nodes / inspect_edges / read. Frame nodes are entries in \`nodes\` with type='frame' — group by parentId to recover the frame tree. Isolated nodes = all node ids minus the union of cluster nodeIds. \`preview\` and \`style\` are opt-in via the matching flags. For full content of any node, call read on "nodes/*.md".`,
  parameters: getCanvasOutlineParamsSchema,
};

export const inspectNodesParamsSchema = Type.Object({
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
          "Find nodes connected to the given node via edges (the target node itself is excluded from results). Each match carries `edgeIds` and `hops`. To inspect an edge's direction / line style / stroke, pass those `edgeIds` to inspect_edges.",
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
  description: `Find canvas nodes by predicate (attribute / spatial / topological) and return each match with full geometry + visual style + derived fields. Predicates AND together. **Always supply at least one predicate** — calling with no predicates returns every node, which is wasteful; for whole-canvas reads use get_canvas_outline instead. Returns JSON: { count, total, truncated, arrangement?, nodes: [{ id, type, label, parentId, position, width, height, style?, distance?, centerDistance?, direction?, edgeIds?, hops?, clusterId? }] }. \`count\` is items in this response (≤ limit); \`total\` is the full match count before \`limit\` was applied — when \`truncated:true\`, raise \`limit\` to ≥\`total\` or refine your query. \`arrangement\` is a human-readable summary of the matched node set's layout (e.g. "4 nodes in a horizontal row", "6 nodes in a 2×3 grid", "3 nodes in a vertical column", "5 nodes scattered"); only emitted when \`count >= 2\`. Note on connectedTo: the target node itself is excluded from results. Use this for "where is X?" (ids), "what's near X?" (nearNode), "what connects to X?" (connectedTo), "what's in this region?" (inRect), or any combination. For full node content (label/text/summary/keywords) call read on "nodes/*.md" — only canvas.json fields are surfaced here.`,
  parameters: inspectNodesParamsSchema,
};

export const inspectEdgesParamsSchema = Type.Object({
  // ── Identity / endpoint predicates ──
  ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Match these edge IDs explicitly. Pair with the `edgeIds` returned by `inspect_nodes({ connectedTo })` to fetch full styling for known edges.',
    }),
  ),
  connectedTo: Type.Optional(
    Type.String({
      description: 'Match all edges incident to this node (source OR target).',
    }),
  ),
  bySource: Type.Optional(
    Type.String({ description: 'Match edges originating from this node.' }),
  ),
  byTarget: Type.Optional(
    Type.String({ description: 'Match edges terminating at this node.' }),
  ),
  between: Type.Optional(
    Type.Object(
      { a: Type.String(), b: Type.String() },
      {
        description:
          'Match edges connecting these two nodes (in either direction).',
      },
    ),
  ),
  // ── EdgeStyle predicates ──
  byDirection: Type.Optional(
    Type.Union([EdgeDirectionSchema, Type.Array(EdgeDirectionSchema)], {
      description:
        "Filter by arrow direction. Treats unset as 'none'. Use 'forward'/'backward'/'both' to find directed edges; 'none' for plain undirected lines.",
    }),
  ),
  byLineStyle: Type.Optional(
    Type.Union([EdgeLineStyleSchema, Type.Array(EdgeLineStyleSchema)], {
      description:
        "Filter by dash pattern. Treats unset as 'solid'. Useful for finding annotation edges (commonly dashed/dotted).",
    }),
  ),
  byLineType: Type.Optional(
    Type.Union([EdgeLineTypeSchema, Type.Array(EdgeLineTypeSchema)], {
      description: "Filter by line shape. Treats unset as 'bezier'.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of edges to return. Default: 50.',
    }),
  ),
});

export const inspectEdgesTool: ToolDefinition = {
  name: 'inspect_edges',
  label: 'Inspect Edges',
  description: `Find canvas edges by predicate (id / endpoints / EdgeStyle attributes) and return each match with its full EdgeStyle. Predicates AND together; with no predicate, every edge is returned (subject to \`limit\`). Returns JSON: { count, total, truncated, edges: [{ id?, source, target, lineType?, lineStyle?, stroke?, strokeWidth?, direction? }] }. \`count\` is items in this response (≤ limit); \`total\` is the full match count before \`limit\` was applied — when \`truncated:true\`, raise \`limit\` to ≥\`total\` or refine your query. EdgeStyle fields are omitted when unset on disk (defaults: \`direction='none'\`, \`lineStyle='solid'\`, \`lineType='bezier'\`); the \`by*\` predicates apply these same defaults so a query like \`byLineStyle:'solid'\` matches edges with no explicit \`lineStyle\` too. Use this when you need styling info — outline only carries topology. Common flows: pass \`edgeIds\` from \`inspect_nodes({ connectedTo })\` via \`ids\`; or query \`byDirection:'forward'\` to find directed edges; or \`byLineStyle:['dashed','dotted']\` to find annotation edges.`,
  parameters: inspectEdgesParamsSchema,
};

// ==================== Canvas Commands ====================

export const canvasCommandsParamsSchema = Type.Object({
  commands: Type.Array(AgentCanvasCommandSchema, {
    description: 'Array of canvas commands to execute as a batch',
  }),
});

export const canvasCommandsTool: ToolDefinition = {
  name: 'canvas_commands',
  label: 'Canvas Commands',
  description: `Execute a batch of canvas commands atomically. All commands in a single call are applied as one undo step.

Supported command types: CREATE_NODES, CREATE_QUESTION, DELETE_NODES, MERGE_NODE_DATA, SET_NODE_PARENT, DISSOLVE_FRAME, SET_NODE_GEOMETRY, REORDER_NODES, CONNECT_NODES, DISCONNECT_EDGES, SET_EDGE_STYLE, ALIGN_NODES, DISTRIBUTE_NODES, AUTO_LAYOUT. Field-level requirements (which fields each command takes) are described by this tool's parameter schema.

ID conventions:
- Node IDs: \`node-<uuid>\` (use crypto.randomUUID()).
- Edge IDs: \`edge-<uuid>\`.
- When a later command in the batch references a node created earlier in the same batch, give that node an explicit \`id\` on its CREATE_NODES entry.

For per-command semantics, idiomatic compositions, and worked examples (group into frame, brainstorm-and-connect, merge/synthesize, restyle a cluster, tidy a row), call \`read("skills/canvas/SKILL.md")\` and follow its links into \`skills/canvas/references/\`.`,
  parameters: canvasCommandsParamsSchema,
  // Force serial execution: two canvas_commands in the same batch can
  // race in two ways. Server-side, the handler reads canvas state once
  // at entry to build a nodeTypeMap — a parallel B that depends on a
  // node freshly created by parallel A wouldn't see it (lost provenance
  // injection). Client-side, SSE tool_result completion order ≠ declared
  // order, and useAgentStream applies commands the moment each result
  // lands (apps/web/src/hooks/useAgentStream.ts), so a MERGE arriving
  // before its CREATE would dispatch against a missing node. Serializing
  // canvas_commands sidesteps both. pi-agent-core's batch behavior means
  // any mixed [read, canvas_commands] batch also runs serial; in
  // practice the agent reads first and writes in a later turn, so the
  // read+write mix is rare and the cost is small.
  executionMode: 'sequential',
};

// ==================== Canvas Filesystem Tools ====================
//
// Tool names and parameter shapes mirror pi-coding-agent / Claude Code
// (`read`, `grep`, `find`, `ls`) so any model already trained on those
// signatures recognizes them. Paths are **relative to the current
// canvas folder** — the agent cannot escape this scope, and there is
// no way to address a different canvas. When `path` is omitted, the
// operation defaults to the canvas root (".").
//
// See `handlers/fs-search.ts` and `handlers/fs-read.ts` for sandbox +
// enrichment details. Shared sandbox primitives live in
// `handlers/fs-sandbox.ts`.

export const readParamsSchema = Type.Object({
  path: Type.String({
    description: 'File path relative to the current canvas folder.',
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
  description: `Read the contents of a **single** text file under the current canvas folder — no globs (use find to enumerate, then read each match). Returns JSON: { path, startLine, endLine, totalLines, truncated, nextOffset?, content, frontmatter? }. Output is truncated to 2000 lines or 50 KB, whichever is hit first; when truncated:true, nextOffset is the 1-indexed line number of the next unread line — pass it as the next offset to keep paging. Binary files (images, archives, .artifacts/*) are rejected with an error.

When the file begins with a YAML frontmatter block ("---" fences), the parsed frontmatter is also returned as a structured object so you don't have to parse YAML yourself.

See 'skills/canvas/SKILL.md' for the canvas folder layout, frontmatter fields per file type, the node filename ↔ label derivation rule, and the read vs inspect_nodes boundary.`,
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
        'Directory or file to search, relative to the current canvas folder. Default: the canvas root. Pass "nodes" to scope to node markdown only.',
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description:
        'Filter files by glob pattern, e.g. "*.md", "**/*.json", "{src,docs}/**". Supports *, **, ?, and {a,b} alternation. Matched against each file\'s path relative to `path` (so `grep({ path: "nodes", glob: "*.md" })` finds every `.md` under `nodes/`). Patterns without "/" auto-match at any depth.',
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
  description: `Search file contents for a pattern within the current canvas folder. Paths are canvas-relative; when omitted, search defaults to the canvas root. Returns JSON: { matches: [...], count, truncated }. \`count\` is matches in this response (≤ limit); \`truncated:true\` means scanning was stopped early (\`limit\` reached or wall-clock budget exhausted) so more matches may exist — raise \`limit\` or refine the pattern. Skips .history/, .git/, and node_modules/. When a match is in nodes/*.md, the result also includes nodeId, label, and nodeType — chain straight into read (for the rest of the file) or inspect_nodes / canvas_commands without a second lookup. Output is capped at 100 matches by default.`,
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
        'Directory to search, relative to the current canvas folder. Default: the canvas root.',
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
  description: `Find files by glob pattern within the current canvas folder. Paths are canvas-relative; when omitted, search defaults to the canvas root. Returns JSON: { paths: [...], count, truncated }. \`count\` is paths in this response (≤ limit); \`truncated:true\` means the walk stopped early at \`limit\` so more files may match — raise \`limit\` or narrow the pattern. When a result is nodes/*.md, the entry also includes nodeId, label, and nodeType. Skips .history/, .git/, and node_modules/.`,
  parameters: findParamsSchema,
};

export const lsParamsSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        'Directory to list, relative to the current canvas folder. Default: the canvas root.',
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
  description: `List directory contents within the current canvas folder. When path is omitted, lists the canvas root. Returns JSON: { path, entries: [...], count, total, truncated }. Entries are sorted alphabetically with a trailing "/" on directories; \`count\` is entries in this response (≤ limit), \`total\` is the full eligible entry count, \`truncated:true\` means \`total > count\` — raise \`limit\` to ≥\`total\`. A canvas folder typically contains canvas.json plus subdirectories such as nodes/, .artifacts/, .history/, and memory/.`,
  parameters: lsParamsSchema,
};

// ==================== Tool Registry ====================

/**
 * Name → definition lookup used by `buildAgentToolsByNames` to resolve
 * the `tools:` list declared in each agent's `AGENT.md` frontmatter.
 *
 * Per-agent tool selection (which tools `ask` / `operate` /
 * `annotation` get) lives in `prompt/agents/<id>/AGENT.md` and is no
 * longer hard-coded here. Adding a tool: append it below + reference
 * its `name` from any AGENT.md that should expose it.
 */
export const TOOL_REGISTRY: Readonly<Record<string, ToolDefinition>> =
  Object.freeze(
    Object.fromEntries(
      [
        webSearchTool,
        getCanvasOutlineTool,
        inspectNodesTool,
        inspectEdgesTool,
        canvasCommandsTool,
        readTool,
        grepTool,
        findTool,
        lsTool,
      ].map((t) => [t.name, t] as const),
    ),
  );
