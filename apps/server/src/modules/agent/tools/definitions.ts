// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool Definitions for the Unified Agent
 *
 * All tools the AI can call across ask, operate, and sketch
 * scopes. Each tool is a pi-ai Tool with a JSON Schema for validation.
 *
 * Definitions here are pure schema + description pairs. The runnable
 * `AgentTool` form (with `execute` closures bound to a request-scoped
 * `canvasId`) is built by `buildToolsForScope` in `./index.ts`.
 *
 * Canvas query and command schemas come from the canonical Zod contracts in
 * `@huabu/shared` and are adapted to pi-ai's TypeBox-compatible shape.
 * Other tools continue to use TypeBox directly.
 */

import { Type } from '@earendil-works/pi-ai';

import {
  AGENT_CANVAS_COMMAND_TYPES,
  builtInAgentCanvasCommandsParamsSchema,
  getSpaceOutlineQueryParamsSchema,
  inspectEdgesQueryParamsSchema,
  inspectNodesQueryParamsSchema,
  snapshotNodesQueryParamsSchema,
  completeTaskRunToolParamsSchema,
  startTaskRunToolParamsSchema,
  createTaskRequestSchema,
} from '@huabu/shared';

import { zodToToolSchema } from './zod-tool-schema.js';

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

const targetCanvasIdSchema = Type.String({
  pattern: '^canvas-.+$',
  description:
    'Optional source Space address for a cross-Space read. Available only when the conversation belongs to World, and only for a targetCanvasId exposed by a canonical canvasRef in the World outline.',
});
const targetCanvasIdProperty = Type.Optional(targetCanvasIdSchema);

function withWorldReadTarget(schema: Tool['parameters']): Tool['parameters'] {
  const objectSchema = schema as Tool['parameters'] & {
    properties?: Record<string, unknown>;
  };
  return Type.Unsafe({
    ...objectSchema,
    properties: {
      ...objectSchema.properties,
      targetCanvasId: targetCanvasIdSchema,
    },
  });
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
//   - `get_space_outline`  — one-shot map of the whole canvas
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
// own structural state (position/size/parent/style on
// nodes, EdgeStyle on edges) plus derived spatial/topological
// metadata.
//
// Every canvas tool defaults to the current request's canvas. A World-owned
// conversation may explicitly address a source Space through targetCanvasId;
// the executor validates it against the canonical Portal topology.

export const getCanvasOutlineParamsSchema = withWorldReadTarget(
  zodToToolSchema(getSpaceOutlineQueryParamsSchema),
);

export const getCanvasOutlineTool: ToolDefinition = {
  name: 'get_space_outline',
  label: 'Get Space Outline',
  description: `One-shot map of the whole Space. Returns JSON: { version, bbox, nodes: [{ id, type, label, filename, parentFrame?: { id, label? }, position, absolutePosition, size: { width, height }, style?, preview?, targetCanvasId?, target? }], edges: [{ id?, source, target }], spatial: { clusters: [{ frameId?, frameLabel?, nodeIds (reading-order), arrangement }] } }. In World, canvasRef entries expose targetCanvasId and nodeRef entries expose target; pass a Portal's targetCanvasId to any read-only tool to inspect that source Space. The server rejects targets not represented by exactly one canonical Portal. Edges are topology-only here — for an edge's direction / line style / stroke / strokeWidth call \`inspect_edges\` instead. Call this once when you enter a Space to orient yourself; later, drill in with inspect_nodes / inspect_edges / read. Frame nodes are entries in \`nodes\` with type='frame' — group by \`parentFrame.id\` to recover the frame tree. Coordinates: \`position\` is parent-local (relative to \`parentFrame\`; absolute for root nodes); \`absolutePosition\` is the resolved world coordinate (read-only). Isolated nodes = all node ids minus the union of cluster nodeIds. \`preview\` and \`style\` are opt-in via the matching flags. For full content of any node, call read on the \`filename\` field ("nodes/*.md").`,
  parameters: getCanvasOutlineParamsSchema,
};

export const inspectNodesParamsSchema = withWorldReadTarget(
  zodToToolSchema(inspectNodesQueryParamsSchema),
);

export const inspectNodesTool: ToolDefinition = {
  name: 'inspect_nodes',
  label: 'Inspect Nodes',
  description: `Find nodes by predicate (attribute / spatial / topological) and return each match with full geometry + visual style + derived fields. Predicates AND together. **Always supply at least one predicate** — calling with no predicates returns every node, which is wasteful; for whole-Space reads use get_space_outline instead. Returns JSON: { count, total, truncated, arrangement?, nodes: [{ id, type, label, filename, parentFrame?: { id, label? }, position, absolutePosition, size: { width, height }, style?, distance?, centerDistance?, direction?, edgeIds?, hops?, clusterId? }] }. Coordinates: \`position\` is parent-local (relative to \`parentFrame\`; absolute for root nodes); \`absolutePosition\` is the resolved world coordinate (read-only). \`count\` is items in this response (≤ limit); \`total\` is the full match count before \`limit\` was applied — when \`truncated:true\`, raise \`limit\` to ≥\`total\` or refine your query. \`arrangement\` is a human-readable summary of the matched node set's layout (e.g. "4 nodes in a horizontal row", "6 nodes in a 2×3 grid", "3 nodes in a vertical column", "5 nodes scattered"); only emitted when \`count >= 2\`. Note on connectedTo: the target node itself is excluded from results. Use this for "where is X?" (ids), "what's near X?" (nearNode), "what connects to X?" (connectedTo), "what's in this region?" (inRect), or any combination. For full node content (label/text/summary/keywords) call read on the \`filename\` field ("nodes/*.md") — only topology fields are surfaced here.`,
  parameters: inspectNodesParamsSchema,
};

export const inspectEdgesParamsSchema = withWorldReadTarget(
  zodToToolSchema(inspectEdgesQueryParamsSchema),
);

export const inspectEdgesTool: ToolDefinition = {
  name: 'inspect_edges',
  label: 'Inspect Edges',
  description: `Find edges by predicate (id / endpoints / EdgeStyle attributes) and return each match with its full EdgeStyle. Predicates AND together. Like \`inspect_nodes\`, prefer at least one predicate; unlike it, a no-predicate call is fine here — it returns every edge (subject to \`limit\`) because edges are typically few and \`get_space_outline\` carries only topology, not EdgeStyle. Reach for a no-predicate call when you specifically need every edge's full style. Returns JSON: { count, total, truncated, edges: [{ id?, source, target, lineType?, lineStyle?, stroke?, strokeWidth?, direction?, label?, labelSource? }] }. \`count\` is items in this response (≤ limit); \`total\` is the full match count before \`limit\` was applied — when \`truncated:true\`, raise \`limit\` to ≥\`total\` or refine your query. EdgeStyle fields are omitted when unset on disk (defaults: \`direction='none'\`, \`lineStyle='solid'\`, \`lineType='bezier'\`, no label); the \`by*\` predicates apply these same defaults so a query like \`byLineStyle:'solid'\` matches edges with no explicit \`lineStyle\` too. \`label\` is short free-text rendered at the edge midpoint; \`labelSource\` records who last set it ('user' / 'agent' / 'auto'). Use this when you need styling info — outline only carries topology. Common flows: pass \`edgeIds\` from \`inspect_nodes({ connectedTo })\` via \`ids\`; or query \`byDirection:'forward'\` to find directed edges; or \`byLabel:'blocks'\` to find labelled edges.`,
  parameters: inspectEdgesParamsSchema,
};

// ==================== Canvas Commands ====================

export const canvasCommandsParamsSchema = zodToToolSchema(
  builtInAgentCanvasCommandsParamsSchema,
);

export const canvasCommandsTool: ToolDefinition = {
  name: 'space_commands',
  label: 'Space Commands',
  description: `Execute Space commands. Commands run in the order given; each command succeeds or fails independently, and every command's outcome — including a failure \`reason\` — is reported back in \`results[]\`. Always check it: a command is not guaranteed to succeed (e.g. CONNECT_NODES / SET_NODE_PARENT fail with \`invalid-target\` when an endpoint doesn't exist).

Batch **independent** commands together (fewer re-renders). **Dependency rule:** the server assigns every node/edge id, so a command can't reference a node created earlier in the **same call or turn** — its id isn't known yet. Create first, read the assigned ids from \`results[].nodes\`, then CONNECT / SET_NODE_PARENT them in a **follow-up call** (next turn). \`ALIGN_NODES\` / \`DISTRIBUTE_NODES\` touch only existing nodes, so they can ride along once you hold the ids.

\`SET_PORTAL_NODE_PINS\` adds or removes symbolic references to source Space nodes inside their Project Portals. It never modifies or deletes the source nodes, and positions are assigned by the host.

Supported command types: ${AGENT_CANVAS_COMMAND_TYPES.join(', ')}. Field-level requirements (which fields each command takes) are described by this tool's parameter schema.

For worked multi-command recipes (group into frame, brainstorm-and-connect, merge/synthesize, restyle a cluster, tidy a row), \`read("skills/space/references/command-cookbook.md")\`; for diagram geometry and layout, \`read("skills/space/references/layout-recipes.md")\`.`,
  parameters: canvasCommandsParamsSchema,
  // Force serial execution: two space_commands in the same batch can
  // race in two ways. Server-side, the handler reads canvas state once
  // at entry to build a nodeTypeMap — a parallel B that depends on a
  // node freshly created by parallel A wouldn't see it (lost provenance
  // injection). Client-side, SSE tool_result completion order ≠ declared
  // order, and useAgentStream applies commands the moment each result
  // lands (apps/web/src/hooks/useAgentStream.ts), so a MERGE arriving
  // before its CREATE would dispatch against a missing node. Serializing
  // space_commands sidesteps both. pi-agent-core's batch behavior means
  // any mixed [read, space_commands] batch also runs serial; in
  // practice the agent reads first and writes in a later turn, so the
  // read+write mix is rare and the cost is small.
  executionMode: 'sequential',
};

// ==================== Task Tools ====================

export const createTaskParamsSchema = zodToToolSchema(createTaskRequestSchema);

export const createTaskTool: ToolDefinition = {
  name: 'create_task',
  label: 'Create Task',
  description:
    'Create one durable Task in the current Space and one static Task Note containing its goal. Use this only when the user explicitly wants durable long-horizon work or delegation; ordinary discussion and Space edits do not need a Task. `defaultRootProfileId` must be an exact selectable external Agent Profile id supplied by the user or current context; ask the user if it is unavailable rather than guessing. Returns `{ task: { taskId, canvasId, goal, defaultRootProfileId, anchorNodeId, createdAt } }`. Creation does not start a Run; use `start_task_run` with the returned taskId when execution should begin.',
  parameters: createTaskParamsSchema,
  executionMode: 'sequential',
};

export const startTaskRunParamsSchema = zodToToolSchema(
  startTaskRunToolParamsSchema,
);

export const startTaskRunTool: ToolDefinition = {
  name: 'start_task_run',
  label: 'Start Task Run',
  description:
    'Start a new Run for an existing Task in the current Space when execution is explicitly requested. Creates a visible fixed root Agent Node and submits the snapshotted Task goal as its first turn. Omit `rootProfileId` to use the Task default; otherwise provide an exact selectable Profile id. `workingDirPath` must be absolute, and launch overrides apply only when the new external Agent thread is first realized. Returns `{ run: { runId, taskId, canvasIdSnapshot, goalSnapshot, rootProfileIdSnapshot, status, rootNodeId, rootThreadId, createdAt, startedAt } }`. A Task may have multiple Runs.',
  parameters: startTaskRunParamsSchema,
  executionMode: 'sequential',
};

export const completeTaskRunParamsSchema = zodToToolSchema(
  completeTaskRunToolParamsSchema,
);

export const completeTaskRunTool: ToolDefinition = {
  name: 'complete_task_run',
  label: 'Complete Task Run',
  description:
    'Explicitly mark one running Task Run as completed after the user or workflow has decided the durable execution unit is finished. Requires the exact Task and Run ids. `message` is optional immutable untrusted text for caller-owned context such as an issue or pull-request outcome; the platform does not interpret it. Repeating the same completion is idempotent, while a different message conflicts. Returns `{ run }` with `status: "completed"` and completion metadata.',
  parameters: completeTaskRunParamsSchema,
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
  targetCanvasId: targetCanvasIdProperty,
  path: Type.String({
    description: 'File path relative to the current Space folder.',
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
  description: `Read the contents of a **single** file under the current Space folder — no globs (use find to enumerate, then read each match). In a World conversation, targetCanvasId may select a source Space exposed by a canonical Portal. Text files return JSON: { path, startLine, endLine, totalLines, truncated, nextOffset?, content, frontmatter?, rev? }, truncated to 2000 lines or 50 KB, whichever is hit first; when truncated:true, nextOffset is the 1-indexed line number of the next unread line — pass it as the next offset to keep paging.

Raster image artifacts (png / jpg / gif / webp, stored under \`.artifacts/\`) are returned **inline as vision content you can actually see** — so to view an inline \`![](<key>)\` image referenced in a note body, call \`read(".artifacts/<key>")\` (the file also shows up as \`.artifacts/<key>\` in find / grep / ls output). Other binary files (pdf / video / archives) are rejected with an error; use the node's \`src\` URL or the Space UI for those.

For a canonical \`nodes/*.md\` sidecar, \`content\` is the authored Markdown body only, \`frontmatter\` contains the parsed node metadata, \`rev\` is the content revision used by guarded writes, and line offsets refer to the body. Other text files preserve their full file content; when one begins with YAML frontmatter, the parsed object is attached without removing the raw fence block.

See 'skills/space/SKILL.md' for the Space folder layout, frontmatter fields per file type, the node filename ↔ label derivation rule, and the read vs inspect_nodes boundary.`,
  parameters: readParamsSchema,
};

export const grepParamsSchema = Type.Object({
  targetCanvasId: targetCanvasIdProperty,
  pattern: Type.String({
    description:
      'Search pattern. Treated as a regular expression by default; set literal=true for plain string matching.',
  }),
  path: Type.Optional(
    Type.String({
      description:
        'Directory or file to search, relative to the current Space folder. Default: the Space root. Pass "nodes" to scope to node markdown only.',
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
  description: `Search file contents for a pattern within the current Space folder. Paths are Space-relative; when omitted, search defaults to the Space root. Returns JSON: { matches: [...], count, truncated }. \`count\` is matches in this response (≤ limit); \`truncated:true\` means scanning was stopped early (\`limit\` reached or wall-clock budget exhausted) so more matches may exist — raise \`limit\` or refine the pattern. Skips .history/, .git/, and node_modules/. When a match is in nodes/*.md, the result also includes nodeId, label, and nodeType — chain straight into read (for the rest of the file) or inspect_nodes / space_commands without a second lookup. Output is capped at 100 matches by default.`,
  parameters: grepParamsSchema,
};

export const findParamsSchema = Type.Object({
  targetCanvasId: targetCanvasIdProperty,
  pattern: Type.String({
    description:
      'Glob pattern to match files, e.g. "*.md", "nodes/*.md", "**/*.json". Patterns without "/" auto-match at any depth.',
  }),
  path: Type.Optional(
    Type.String({
      description:
        'Directory to search, relative to the current Space folder. Default: the Space root.',
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
  description: `Find files by glob pattern within the current Space folder. Paths are Space-relative; when omitted, search defaults to the Space root. Returns JSON: { paths: [...], count, truncated }. \`count\` is paths in this response (≤ limit); \`truncated:true\` means the walk stopped early at \`limit\` so more files may match — raise \`limit\` or narrow the pattern. When a result is nodes/*.md, the entry also includes nodeId, label, and nodeType. Skips .history/, .git/, and node_modules/.`,
  parameters: findParamsSchema,
};

export const lsParamsSchema = Type.Object({
  targetCanvasId: targetCanvasIdProperty,
  path: Type.Optional(
    Type.String({
      description:
        'Directory to list, relative to the current Space folder. Default: the Space root.',
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
  description: `List directory contents within the current Space folder. When path is omitted, lists the Space root. Returns JSON: { path, entries: [...], count, total, truncated }. Entries are sorted alphabetically with a trailing "/" on directories; \`count\` is entries in this response (≤ limit), \`total\` is the full eligible entry count, \`truncated:true\` means \`total > count\` — raise \`limit\` to ≥\`total\`. A Space folder typically contains space.json plus subdirectories such as nodes/, .artifacts/, .history/, and memory/.`,
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
      'Virtual file path. Supported targets: "memory/user.md" (cross-Space profile), "memory/space.md" (this-Space briefing), "skills/<id>/SKILL.md" (user skill). Mirrors the paths accepted by the `read` tool.',
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
        'Required when mode="overwrite". Wholesale file contents; a trailing newline is added if absent. For "memory/user.md" and "memory/space.md" the body is capped at 4 KB / 80 lines; skills are uncapped.',
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
    'Write to a memory or skill file by virtual path. Two modes: "overwrite" (wholesale contents, creates the file if missing) and "replace_string" (Claude-Code style unique-substring edit). Supported paths: "memory/user.md", "memory/space.md", "skills/<id>/SKILL.md" — same set the `read` tool accepts. Skill creates require a `rationale`. Discipline + per-target guidance: `read("skills/memory/write/user-memory-writing.md" | "skills/memory/write/space-memory-writing.md" | "skills/memory/write/skills-writing.md")`.',
  parameters: fsWriteParamsSchema,
  executionMode: 'sequential',
};

// ==================== Image Tools ====================

export const snapshotNodesParamsSchema = zodToToolSchema(
  snapshotNodesQueryParamsSchema,
);

export const snapshotNodesTool: ToolDefinition = {
  name: 'snapshot_nodes',
  label: 'Snapshot nodes',
  description:
    "Snapshot current-Space nodes into PNG attachments — use the returned `src` as a vision attachment (so you can SEE the node) or as `generate_image.referenceArtifactSrcs`. This tool materializes cache artifacts and therefore remains scoped to the conversation owner; in World, use read with a validated targetCanvasId to view a source image inline. Call this for any `image` / `sketch` node you've located via `get_space_outline` / `inspect_nodes`; `frame` is also accepted and recursively expands to its image/sketch children. For `note` / `text` / `pdf` / `video` use `read(\"nodes/<file>.md\")` instead — they have no still image.\n\nMultiple ids are spatially clustered per parent frame (edge-to-edge ≤ 200 px): nearby image+sketch nodes composite into ONE PNG (images as backdrop, strokes on top); distant ids stay separate. A single image id short-circuits to that node's original artifact (or a downscaled copy when its longest edge exceeds `maxPixels`), so pass one id at a time when you want full-resolution pixels — e.g. drilling into a member of an earlier cluster.\n\nTo see only PART of a sketch (e.g. a few lassoed strokes), pass `strokeSubsets: [{ nodeId, strokeIds }]` (a KEEP list) — that node then renders only those strokes; others render in full. If none of the listed ids still exist, the tool returns a stale-selection error instead of rendering the whole sketch.\n\nReturns `Array<{src, width, height, originNodeIds}>`; `originNodeIds` lists every contributing node. The chat route already auto-snapshots the user's selection on your first turn (keys appear in user-message metadata), so don't re-snapshot the same selection unless you need full-res single-image pixels or a smaller `maxPixels` retry.",
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
    "Generate a new image and persist it into the current Space's artifact store. Returns JSON `{src, width, height, revisedPrompt?}` — `src` is an artifact key like `art_xyz.png`. **If you need to place the image on the Space**, follow up with a `space_commands` call: `{type:'CREATE_NODES', nodes:[{nodeType:'image', data:{src:'<the src>', label:'<short caption>'}, position:{x,y}, size:{width,height}}]}` — pick a free spot near the user's current focus. To use existing Space content as visual reference, call `snapshot_nodes` with the source node ids and pass the returned `src` strings via `referenceArtifactSrcs`. **In your final chat reply, embed the generated image inline using markdown image syntax `![<short caption>](<the src>)` so the user sees it immediately** — do NOT use link syntax `[…](…)` (renders as a broken link, not an image), do NOT describe what's in the image (the user can see it), do NOT list pixel dimensions, and keep any surrounding text to a brief one-line confirmation. Requires Azure OpenAI with an Image Deployment configured in Settings → LLM Provider.",
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
        createTaskTool,
        startTaskRunTool,
        completeTaskRunTool,
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
