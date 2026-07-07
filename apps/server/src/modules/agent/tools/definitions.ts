/**
 * Tool Definitions for the Unified Agent
 *
 * All tools the AI can call across ask, operate, and sketch
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
        'Attach text scan hints to every node: `summary` (authored abstract, when present) and `preview` (first ~120 chars of the body). Default: false. Skip unless you need a quick overview of contents — for full text use read on "nodes/*.md".',
    }),
  ),
  includeStyle: Type.Optional(
    Type.Boolean({
      description:
        "Attach each node's visual style (accent color token + text styling). Default: false. Set true only for visual / styling tasks.",
    }),
  ),
});

export const getCanvasOutlineTool: ToolDefinition = {
  name: 'get_canvas_outline',
  label: 'Get Canvas Outline',
  description: `One-shot map of the whole canvas. Returns JSON: { canvasId, version, bbox, nodes: [{ id, type, label, filename, parentFrame?: { id, label? }, position, size: { width, height }, style?, preview? }], edges: [{ id?, source, target }], spatial: { clusters: [{ frameId?, frameLabel?, nodeIds (reading-order), arrangement }] } }. Edges are topology-only here — for an edge's direction / line style / stroke / strokeWidth call \`inspect_edges\` instead. Call this once when you enter a canvas to orient yourself; later, drill in with inspect_nodes / inspect_edges / read. Frame nodes are entries in \`nodes\` with type='frame' — group by \`parentFrame.id\` to recover the frame tree. Isolated nodes = all node ids minus the union of cluster nodeIds. \`preview\` and \`style\` are opt-in via the matching flags. For full content of any node, call read on the \`filename\` field ("nodes/*.md").`,
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
  description: `Find canvas nodes by predicate (attribute / spatial / topological) and return each match with full geometry + visual style + derived fields. Predicates AND together. **Always supply at least one predicate** — calling with no predicates returns every node, which is wasteful; for whole-canvas reads use get_canvas_outline instead. Returns JSON: { count, total, truncated, arrangement?, nodes: [{ id, type, label, filename, parentFrame?: { id, label? }, position, size: { width, height }, style?, distance?, centerDistance?, direction?, edgeIds?, hops?, clusterId? }] }. \`count\` is items in this response (≤ limit); \`total\` is the full match count before \`limit\` was applied — when \`truncated:true\`, raise \`limit\` to ≥\`total\` or refine your query. \`arrangement\` is a human-readable summary of the matched node set's layout (e.g. "4 nodes in a horizontal row", "6 nodes in a 2×3 grid", "3 nodes in a vertical column", "5 nodes scattered"); only emitted when \`count >= 2\`. Note on connectedTo: the target node itself is excluded from results. Use this for "where is X?" (ids), "what's near X?" (nearNode), "what connects to X?" (connectedTo), "what's in this region?" (inRect), or any combination. For full node content (label/text/summary/keywords) call read on the \`filename\` field ("nodes/*.md") — only canvas.json fields are surfaced here.`,
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
  byLabel: Type.Optional(
    Type.String({
      description:
        'Case-insensitive substring match on the edge label. Edges with no label never match. Useful for finding e.g. all edges labelled "blocks" or "depends on".',
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
  description: `Find canvas edges by predicate (id / endpoints / EdgeStyle attributes) and return each match with its full EdgeStyle. Predicates AND together; with no predicate, every edge is returned (subject to \`limit\`). Returns JSON: { count, total, truncated, edges: [{ id?, source, target, lineType?, lineStyle?, stroke?, strokeWidth?, direction?, label?, labelSource? }] }. \`count\` is items in this response (≤ limit); \`total\` is the full match count before \`limit\` was applied — when \`truncated:true\`, raise \`limit\` to ≥\`total\` or refine your query. EdgeStyle fields are omitted when unset on disk (defaults: \`direction='none'\`, \`lineStyle='solid'\`, \`lineType='bezier'\`, no label); the \`by*\` predicates apply these same defaults so a query like \`byLineStyle:'solid'\` matches edges with no explicit \`lineStyle\` too. \`label\` is short free-text rendered at the edge midpoint; \`labelSource\` records who last set it ('user' / 'agent' / 'auto'). Use this when you need styling info — outline only carries topology. Common flows: pass \`edgeIds\` from \`inspect_nodes({ connectedTo })\` via \`ids\`; or query \`byDirection:'forward'\` to find directed edges; or \`byLabel:'blocks'\` to find labelled edges.`,
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

Supported command types: CREATE_NODES, DELETE_NODES, MERGE_NODE_DATA, SET_NODE_PARENT, DISSOLVE_FRAME, SET_NODE_GEOMETRY, REORDER_NODES, CONNECT_NODES, DISCONNECT_EDGES, SET_EDGE_STYLE, ALIGN_NODES, DISTRIBUTE_NODES, SET_FRAME_LAYOUT. Field-level requirements (which fields each command takes) are described by this tool's parameter schema.

**Image Nodes - Automatic Aspect Ratio Preservation:**
For image nodes, set only \`width\` — via \`size.width\` in \`CREATE_NODES\`, an updated \`src\` in \`MERGE_NODE_DATA\`, or \`size.width\` in \`SET_NODE_GEOMETRY\`; the server always derives \`height\` from the image's actual ratio (any \`height\` you pass is ignored) and returns the final \`width\`/\`height\` in the tool result \`results[].nodes\`.

**Text / Question Nodes - Content-Driven Height:**
For \`text\` and \`question\` nodes, set only \`size.width\` in \`CREATE_NODES\` / \`SET_NODE_GEOMETRY\`. Their height is content-driven and must not be pinned with \`size.height\`; to make the rendered text larger or smaller, set \`data.style.fontSize\` via \`CREATE_NODES\` or \`MERGE_NODE_DATA\`.

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

// ==================== Filesystem Write ====================
//
// Single write entry point, symmetrical to `read`. The agent picks a
// virtual `path` (same set `read` accepts) and a `mode` —
// `overwrite` for wholesale file contents, `replace_string` for a
// Claude-Code style unique-substring edit.
//
// Path → tier routing, sandboxing, cap enforcement, workspace-mutex
// serialisation, and skill-cache invalidation all live in the
// handler / writers; this schema deliberately stays flat so the LLM
// only ever sees the simple shape "give me a path + a mode + the
// fields the mode needs".
//
// Marked `executionMode: 'sequential'` so a batch of writes (e.g.
// edit then overwrite the same file) applies in declared order.

export const fsWriteParamsSchema = Type.Object({
  path: Type.String({
    description:
      'Virtual file path. Supported targets: "memory/workspace.md" (cross-canvas profile), "memory/canvas.md" (this-canvas briefing), "skills/<id>/SKILL.md" (user skill). Mirrors the paths accepted by the `read` tool.',
  }),
  mode: Type.Union(
    [Type.Literal('overwrite'), Type.Literal('replace_string')],
    {
      description:
        '"overwrite" writes `body` as the entire file contents (creates the file if missing). "replace_string" finds `oldString` (must occur exactly once) and replaces it with `newString` — the file must already exist.',
    },
  ),
  body: Type.Optional(
    Type.String({
      description:
        'Required when mode="overwrite". Wholesale file contents; a trailing newline is added if absent. For "memory/workspace.md" and "memory/canvas.md" the body is capped at 4 KB / 80 lines; skills are uncapped.',
    }),
  ),
  oldString: Type.Optional(
    Type.String({
      description:
        'Required when mode="replace_string". The exact substring to find — must appear in the file exactly once. Add more surrounding context if the snippet is ambiguous.',
    }),
  ),
  newString: Type.Optional(
    Type.String({
      description:
        'Required when mode="replace_string". The substring to substitute in. Use "" to delete the matched range.',
    }),
  ),
  rationale: Type.Optional(
    Type.String({
      description:
        'Required only when creating a new skill (mode="overwrite" on a "skills/<id>/SKILL.md" path that does not yet exist), ≥ 20 chars: explain why no existing skill could be updated instead. Ignored in every other case.',
    }),
  ),
});

export const fsWriteTool: ToolDefinition = {
  name: 'fs_write',
  label: 'Write file',
  description:
    'Write to a memory or skill file by virtual path. Two modes: "overwrite" (wholesale contents, creates the file if missing) and "replace_string" (Claude-Code style unique-substring edit). Supported paths: "memory/workspace.md", "memory/canvas.md", "skills/<id>/SKILL.md" — same set the `read` tool accepts. Skill creates require a `rationale`. Discipline + per-target guidance: `read("skills/memory/write/workspace-memory-writing.md" | "skills/memory/write/canvas-memory-writing.md" | "skills/memory/write/skills-writing.md")`.',
  parameters: fsWriteParamsSchema,
  executionMode: 'sequential',
};

// ==================== Image Tools ====================

export const snapshotNodesParamsSchema = Type.Object({
  nodeIds: Type.Array(Type.String(), {
    description:
      'Ids of the nodes to snapshot, as they appear in `get_canvas_outline` / `inspect_nodes`. All nodes must live on the current canvas. Pass a single id for a one-shot snapshot; pass multiple ids to let the tool spatially cluster nearby image and sketch nodes into one composite PNG per cluster.',
  }),
  maxPixels: Type.Optional(
    Type.Integer({
      minimum: 256,
      maximum: 4096,
      description:
        'Optional longest-edge pixel cap for the output PNG (256-4096). Defaults to 1280 — enough resolution for vision while keeping a single attachment well under the upstream LLM’s body-size limit. Reduce this (e.g. to 768 or 512) when a previous turn returned `[Attached Image: … omitted from vision (~X.X MB exceeds the inline cap)]` so the resulting PNG is small enough to actually be sent. Applies uniformly to: rendered clusters (re-rendered at the new cap), and singleton image pass-throughs (re-rasterized only when the source’s longest edge exceeds `maxPixels`; otherwise the original artifact is returned unchanged). Result is content-addressed by `(source, maxPixels)`, so the same call is essentially free on repeat.',
    }),
  ),
});

export const snapshotNodesTool: ToolDefinition = {
  name: 'snapshot_nodes',
  label: 'Snapshot nodes',
  description:
    "Snapshot canvas nodes into PNG attachments — use the returned `src` as a vision attachment (so you can SEE the node) or as `generate_image.referenceArtifactSrcs`. Call this for any `image` / `sketch` node you've located via `get_canvas_outline` / `inspect_nodes`; `frame` is also accepted and recursively expands to its image/sketch children. For `note` / `text` / `pdf` / `video` use `read(\"nodes/<file>.md\")` instead — they have no still image.\n\nMultiple ids are spatially clustered per parent frame (edge-to-edge ≤ 200 px): nearby image+sketch nodes composite into ONE PNG (images as backdrop, strokes on top); distant ids stay separate. A single image id short-circuits to that node's original artifact (or a downscaled copy when its longest edge exceeds `maxPixels`), so pass one id at a time when you want full-resolution pixels — e.g. drilling into a member of an earlier cluster.\n\nReturns `Array<{src, width, height, originNodeIds}>`; `originNodeIds` lists every contributing node. The chat route already auto-snapshots the user's selection on your first turn (keys appear in user-message metadata), so don't re-snapshot the same selection unless you need full-res single-image pixels or a smaller `maxPixels` retry.",
  parameters: snapshotNodesParamsSchema,
};

export const generateImageParamsSchema = Type.Object({
  prompt: Type.String({
    description:
      "Plain-text description of the image to generate, in the user's language. Be specific about subject, style, lighting, composition. When using reference images, describe what to change / preserve relative to them.",
  }),
  referenceArtifactSrcs: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Optional list of artifact keys (the `src` strings from `snapshot_nodes` or from existing `image` nodes) to use as visual references. When provided, the tool calls the image-edit endpoint instead of pure text-to-image. Pass each key as a bare string, e.g. `"art_xyz.png"`.',
    }),
  ),
  size: Type.Optional(
    Type.String({
      description:
        "Output dimensions as a `WIDTHxHEIGHT` string. Default `'1024x1024'`. The legal set depends on the image deployment the user has configured in Settings — pass what the user asked for and the server will forward it to the provider. Common values: gpt-image-1 accepts `'1024x1024'` / `'1024x1536'` (portrait) / `'1536x1024'` (landscape) / `'auto'`; dall-e-3 accepts `'1024x1024'` / `'1024x1792'` (portrait) / `'1792x1024'` (landscape). If unsure, omit this and accept the square default.",
    }),
  ),
  quality: Type.Optional(
    Type.Union(
      [
        Type.Literal('low'),
        Type.Literal('medium'),
        Type.Literal('high'),
        Type.Literal('auto'),
      ],
      {
        description:
          "Rendering quality. Default `'low'` (fast + cheap, fine for most chat-driven asks). Use `'medium'` or `'high'` only when the user explicitly asks for a polished / hi-res result — each step up roughly multiplies cost and latency.",
      },
    ),
  ),
});

export const generateImageTool: ToolDefinition = {
  name: 'generate_image',
  label: 'Generate image',
  description:
    "Generate a new image and persist it into the current canvas's artifact store. Returns JSON `{src, width, height, revisedPrompt?}` — `src` is an artifact key like `art_xyz.png`. **If you need to place the image on the canvas**, follow up with a `canvas_commands` call: `{type:'CREATE_NODES', nodes:[{nodeType:'image', data:{src:'<the src>', label:'<short caption>'}, position:{x,y}, size:{width,height}}]}` — pick a free spot near the user's current focus. To use existing canvas content as visual reference, call `snapshot_nodes` with the source node ids and pass the returned `src` strings via `referenceArtifactSrcs`. **In your final chat reply, embed the generated image inline using markdown image syntax `![<short caption>](<the src>)` so the user sees it immediately** — do NOT use link syntax `[…](…)` (renders as a broken link, not an image), do NOT describe what's in the image (the user can see it), do NOT list pixel dimensions, and keep any surrounding text to a brief one-line confirmation. Requires Azure OpenAI with an Image Deployment configured in Settings → LLM Provider.",
  parameters: generateImageParamsSchema,
  // Image generation is slow (5-30s); marking sequential prevents the
  // agent from racing two parallel generations against the same
  // canvas which would also fight for the same name slot.
  executionMode: 'sequential',
};

// ==================== Tool Registry ====================

/**
 * Name → definition lookup used by `buildAgentToolsByNames` to resolve
 * the `tools:` list declared in each agent's `AGENT.md` frontmatter.
 *
 * Per-agent tool selection (which tools `ask` / `operate` /
 * `sketch` get) lives in `prompt/agents/<id>/AGENT.md` and is no
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
        fsWriteTool,
        snapshotNodesTool,
        generateImageTool,
      ].map((t) => [t.name, t] as const),
    ),
  );
