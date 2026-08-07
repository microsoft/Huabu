/**
 * Agent loader — markdown AGENT.md files as the single source of truth.
 *
 * Each agent lives at `<thisDir>/<id>/AGENT.md` (where `<thisDir>` is
 * `src/prompt/agents/`). The YAML frontmatter declares the agent's
 * identity, tool list (by name — resolved by {@link buildAgentToolsByNames}
 * against the registry in `modules/agent/tools/index.ts`), optional skill
 * scope, and runtime knobs. The Markdown body is the system prompt, with
 * two template facilities:
 *
 *   `{{skillCatalogue}}`             → expanded to the catalogue lines
 *                                      for the agent's `skillScope`
 *                                      (empty string when absent).
 *   `{{#skillCatalogue}}...{{/...}}` → block kept only when the
 *                                      catalogue is non-empty.
 *   `{{include:<rel>}}`              → spliced in at load time with the
 *                                      contents of `<prompt-root>/<rel>`.
 *                                      Use this when two agents need
 *                                      to share the same prose (e.g.
 *                                      the Space read-side mental
 *                                      model lives in
 *                                      `skills/space/SKILL.md` and
 *                                      multiple agents inline it via
 *                                      `{{include:skills/space/SKILL.md}}`).
 *                                      Paths are PROMPT-ROOT relative;
 *                                      escapes outside
 *                                      `apps/server/src/prompt/` throw
 *                                      at load time. Nested includes are
 *                                      forbidden — the included file may
 *                                      not contain its own
 *                                      `{{include:...}}` directive (keeps
 *                                      the loader trivial and prevents
 *                                      cycles).
 *
 * Validation failures throw at load time so a malformed agent cannot
 * ship silently. Bodies are read on first access and cached for the
 * process lifetime; {@link invalidateAgentCache} forces a re-scan
 * (intended for tests / future hot-reload).
 *
 * Runtime layout mirrors the skill loader: dev (tsx) and start (tsx)
 * both run from `src/`, so the relative `<thisDir>/<id>/AGENT.md`
 * layout works. Any future `dist/` build must copy
 * `src/prompt/agents/**\/AGENT.md` into `dist/prompt/agents/`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../../utils/markdown-frontmatter.js';
import { getSkillCatalogue } from '../skills/catalogue.js';

import type { SkillScope } from '../skills/loader.js';
import type { ToolExecutionMode } from '@earendil-works/pi-agent-core';
import type { NodeOrigin } from '@sediment/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Agent identifiers backed by an `AGENT.md` config file. */
export type AgentId = 'ask' | 'operate' | 'intent' | 'sketch' | 'memory';

const VALID_AGENT_IDS: ReadonlySet<AgentId> = new Set<AgentId>([
  'ask',
  'operate',
  'intent',
  'sketch',
  'memory',
]);

/** Runtime knobs forwarded to `runAgent` / direct LLM callers. */
export interface AgentRuntimeConfig {
  /** Soft cap on agent turns (LLM call + tool batch). */
  maxIterations?: number;
  /**
   * Tool execution mode forwarded to pi-agent-core. `'sequential'`
   * forces the whole batch to run serially; `'parallel'` (the
   * default) lets independent tool calls overlap.
   */
  toolExecution?: ToolExecutionMode;
  /**
   * `NodeOrigin` stamp injected onto every node created by
   * `space_commands`. Used by the sketch pipeline to mark nodes
   * as user-authored rather than AI-initiated.
   */
  defaultOrigin?: NodeOrigin;
}

/** Parsed AGENT.md frontmatter. */
export interface AgentFrontmatter {
  id: AgentId;
  name: string;
  description: string;
  /** Tool names resolved by `buildAgentToolsByNames`. Empty for tool-less agents (e.g. intent). */
  tools: string[];
  /**
   * Skill surface filter for `getSkillCatalogue`. When omitted or
   * null, no catalogue is injected into the prompt.
   */
  skillScope?: SkillScope | null;
  runtime?: AgentRuntimeConfig;
  /**
   * Named user-message fragments rendered on demand by
   * {@link renderAgentTemplate}. Use these for any prose that wraps
   * structured data assembled in code (selected-node preambles,
   * spatial-context blocks, screenshot captions, …) so the wording
   * lives next to the system prompt instead of being scattered
   * across service files.
   *
   * Same Mustache-flavoured syntax as the system prompt body:
   * `{{var}}` for substitution, `{{#var}}…{{/var}}` for conditional
   * blocks (kept only when the variable is a non-empty string).
   */
  messageTemplates?: Record<string, string>;
}

export interface LoadedAgent {
  id: AgentId;
  name: string;
  description: string;
  /**
   * System prompt with template variables expanded.
   *
   * Re-rendered on every {@link loadAgent} call so the
   * `{{skillCatalogue}}` block reflects current user-side skills.
   * The expensive bit (parsing AGENT.md + validating frontmatter) is
   * still cached — only the cheap mustache pass against the live
   * catalogue runs each call.
   */
  systemPrompt: string;
  /** Tool names declared in frontmatter, in declaration order. */
  toolNames: string[];
  runtime: AgentRuntimeConfig;
  /** Raw (un-rendered) message templates from the frontmatter. */
  messageTemplates: Record<string, string>;
  /** Absolute path of the AGENT.md file on disk. */
  sourcePath: string;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the on-disk prompt directories.
 *
 * Two runtime layouts are supported:
 *   ─ Source (tsx, dev / start scripts): this file sits at
 *     `src/prompt/agents/loader.js`, so `HERE = src/prompt/agents/`
 *     and `PROMPT_ROOT = src/prompt/`.
 *   ─ Bundled (tsup → `dist-bundle/server.js`): all loaders collapse
 *     into the single bundle, so `HERE = dist-bundle/`. The tsup
 *     `onSuccess` step copies `src/prompt/` to `dist-bundle/prompt/`,
 *     so we detect that subdir and re-root onto it.
 */
const BUNDLED_PROMPT_ROOT = path.join(HERE, 'prompt');
const IS_BUNDLED = existsSync(path.join(BUNDLED_PROMPT_ROOT, 'agents'));

/** Absolute path of the agents directory. */
export const AGENTS_DIR = IS_BUNDLED
  ? path.join(BUNDLED_PROMPT_ROOT, 'agents')
  : HERE;

/**
 * Root for `{{include:<rel>}}` path resolution. Includes are resolved
 * relative to this directory, and the resolved absolute path must
 * stay within it — a path traversal that escapes the root throws at
 * load time. Pointing at the shared parent of `agents/` and `skills/`
 * means an AGENT.md can pull in either a sibling agent's fragment or
 * any global skill without `../../` confusion.
 */
const PROMPT_ROOT = IS_BUNDLED ? BUNDLED_PROMPT_ROOT : path.resolve(HERE, '..');

// ─── Validation ─────────────────────────────────────────────────────────────

const VALID_SKILL_SCOPES: ReadonlySet<SkillScope> = new Set<SkillScope>([
  'ask',
  'operate',
  'sketch',
  'external',
]);

const VALID_TOOL_EXECUTION: ReadonlySet<ToolExecutionMode> =
  new Set<ToolExecutionMode>(['parallel', 'sequential']);

const VALID_ORIGIN_TYPES: ReadonlySet<NodeOrigin['type']> = new Set<
  NodeOrigin['type']
>([
  'ai-operate',
  'user-created',
  'user-uploaded',
  'user-pasted',
  'user-from-library',
  'user-from-chat',
  'user-excerpt',
  'sketch-recognized',
]);

function validateRuntime(raw: unknown, sourcePath: string): AgentRuntimeConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`[agent-loader] ${sourcePath}: runtime must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const out: AgentRuntimeConfig = {};

  if (r.maxIterations !== undefined) {
    if (typeof r.maxIterations !== 'number' || r.maxIterations < 1) {
      throw new Error(
        `[agent-loader] ${sourcePath}: runtime.maxIterations must be a positive number`,
      );
    }
    out.maxIterations = r.maxIterations;
  }

  if (r.toolExecution !== undefined) {
    const v = String(r.toolExecution) as ToolExecutionMode;
    if (!VALID_TOOL_EXECUTION.has(v)) {
      throw new Error(
        `[agent-loader] ${sourcePath}: runtime.toolExecution must be one of ${[...VALID_TOOL_EXECUTION].join(', ')}`,
      );
    }
    out.toolExecution = v;
  }

  if (r.defaultOrigin !== undefined) {
    const o = r.defaultOrigin;
    if (
      typeof o !== 'object' ||
      o === null ||
      typeof (o as { type?: unknown }).type !== 'string'
    ) {
      throw new Error(
        `[agent-loader] ${sourcePath}: runtime.defaultOrigin must be an object with a string "type"`,
      );
    }
    const t = (o as { type: string }).type as NodeOrigin['type'];
    if (!VALID_ORIGIN_TYPES.has(t)) {
      throw new Error(
        `[agent-loader] ${sourcePath}: runtime.defaultOrigin.type "${t}" is not a known NodeOrigin type`,
      );
    }
    // Trust the rest of the shape — the discriminated union allows a
    // few optional fields per branch and validating each here would
    // drift from the source of truth in `@sediment/shared`.
    out.defaultOrigin = o as NodeOrigin;
  }

  return out;
}

function validateFrontmatter(
  raw: Record<string, unknown>,
  sourcePath: string,
  expectedId: string,
): AgentFrontmatter {
  for (const key of ['id', 'name', 'description', 'tools'] as const) {
    if (raw[key] === undefined || raw[key] === null) {
      throw new Error(
        `[agent-loader] ${sourcePath}: missing required frontmatter key "${key}"`,
      );
    }
  }

  const id = String(raw.id);
  if (!VALID_AGENT_IDS.has(id as AgentId)) {
    throw new Error(
      `[agent-loader] ${sourcePath}: frontmatter id "${id}" is not a known agent id`,
    );
  }
  if (id !== expectedId) {
    throw new Error(
      `[agent-loader] ${sourcePath}: frontmatter id "${id}" does not match directory name "${expectedId}"`,
    );
  }

  if (!Array.isArray(raw.tools)) {
    throw new Error(
      `[agent-loader] ${sourcePath}: tools must be an array (use [] for tool-less agents)`,
    );
  }
  const tools = raw.tools.map((t) => String(t));

  let skillScope: SkillScope | null | undefined;
  if (raw.skillScope === null || raw.skillScope === undefined) {
    skillScope = null;
  } else {
    const s = String(raw.skillScope) as SkillScope;
    if (!VALID_SKILL_SCOPES.has(s)) {
      throw new Error(
        `[agent-loader] ${sourcePath}: skillScope "${s}" must be one of ${[...VALID_SKILL_SCOPES].join(', ')}`,
      );
    }
    skillScope = s;
  }

  let messageTemplates: Record<string, string> | undefined;
  if (raw.messageTemplates !== undefined && raw.messageTemplates !== null) {
    const m = raw.messageTemplates;
    if (typeof m !== 'object' || Array.isArray(m)) {
      throw new Error(
        `[agent-loader] ${sourcePath}: messageTemplates must be an object of string templates`,
      );
    }
    messageTemplates = {};
    for (const [key, value] of Object.entries(m)) {
      if (typeof value !== 'string') {
        throw new Error(
          `[agent-loader] ${sourcePath}: messageTemplates.${key} must be a string`,
        );
      }
      messageTemplates[key] = value;
    }
  }

  return {
    id: id as AgentId,
    name: String(raw.name),
    description: String(raw.description),
    tools,
    skillScope,
    runtime: validateRuntime(raw.runtime, sourcePath),
    messageTemplates,
  };
}

// ─── Templating ─────────────────────────────────────────────────────────────

/**
 * Resolve a `{{include:<rel>}}` path against {@link PROMPT_ROOT} and
 * read the file. Throws on traversal escapes (`../../../etc/passwd`)
 * and on absolute paths so that includes can only reach files we
 * ship inside the prompt tree.
 */
function resolveTemplateInclude(rel: string): string {
  const trimmed = rel.trim();
  if (!trimmed) {
    throw new Error(`[agent-loader] {{include}} requires a non-empty path`);
  }
  if (path.isAbsolute(trimmed)) {
    throw new Error(
      `[agent-loader] {{include:${trimmed}}} must be PROMPT-ROOT relative, not absolute`,
    );
  }
  const resolved = path.resolve(PROMPT_ROOT, trimmed);
  const inside = path.relative(PROMPT_ROOT, resolved);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(
      `[agent-loader] {{include:${trimmed}}} escapes the prompt root (${PROMPT_ROOT})`,
    );
  }
  if (!existsSync(resolved)) {
    throw new Error(
      `[agent-loader] {{include:${trimmed}}} → file not found at ${resolved}`,
    );
  }
  const body = readFileSync(resolved, 'utf8');
  // No recursion: keeps the loader trivial and rules out cycles.
  if (/\{\{include:/.test(body)) {
    throw new Error(
      `[agent-loader] {{include:${trimmed}}} → included file contains its own {{include:...}}; nested includes are not supported`,
    );
  }
  return body;
}

/**
 * Minimal Mustache-flavoured template renderer.
 *
 * Supports three constructs:
 *   - `{{include:<rel>}}`    → replaced at LOAD TIME with the contents of
 *                              the file at `<prompt-root>/<rel>`. Runs
 *                              before substitution so the included
 *                              body participates in subsequent `{{key}}`
 *                              passes. See {@link resolveTemplateInclude}
 *                              for the safety rules.
 *   - `{{key}}`              → replaced by `vars[key]` (empty string when missing).
 *   - `{{#key}}...{{/key}}`  → kept only when `vars[key]` is a non-empty string.
 *                              The block (and a single trailing newline,
 *                              if present) is removed otherwise so the
 *                              output stays cleanly unindented.
 *
 * Intentionally narrow scope: no nesting, no inverted sections, no
 * loops. Anything more complex belongs in code, not in a config file.
 */
function renderTemplate(body: string, vars: Record<string, string>): string {
  // 0) Load-time includes first so the spliced-in content participates
  //    in the subsequent passes (variables / conditionals defined in
  //    the calling AGENT.md can interpolate INTO an included fragment).
  //    The trailing-newline swallow keeps the surrounding block clean
  //    when the include sits on its own line.
  const includeRe = /\{\{include:([^}]+)\}\}\n?/g;
  let out = body.replace(includeRe, (_, rel: string) =>
    resolveTemplateInclude(rel),
  );
  // 1) Conditional blocks next so the substitution pass below doesn't
  //    accidentally fill the surrounding section header before we get
  //    a chance to drop it.
  const blockRe = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}\n?/g;
  out = out.replace(blockRe, (_, key: string, inner: string) => {
    const value = vars[key];
    return value && value.length > 0 ? inner : '';
  });
  // 2) Plain {{key}} substitution.
  out = out.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
  return out;
}

/**
 * Render a named message template from `agent.messageTemplates`.
 *
 * Throws when the template is not declared on the agent so a typo or
 * missing entry fails loudly at the call site rather than silently
 * producing an empty user message. The trailing newline of the YAML
 * literal-block scalar is stripped — callers control their own
 * separators when composing multi-part messages.
 */
export function renderAgentTemplate(
  agent: LoadedAgent,
  templateKey: string,
  vars: Record<string, string> = {},
): string {
  const tpl = agent.messageTemplates[templateKey];
  if (tpl === undefined) {
    throw new Error(
      `[agent-loader] Agent "${agent.id}" has no messageTemplate "${templateKey}". Declared templates: [${Object.keys(agent.messageTemplates).join(', ') || '(none)'}]`,
    );
  }
  return renderTemplate(tpl, vars).replace(/\n$/, '');
}

/**
 * Render a standalone prompt template file that is **not** attached to
 * any `AgentId` / `messageTemplates` entry.
 *
 * `relPath` is resolved against {@link PROMPT_ROOT} (the shared parent
 * of `agents/` and `skills/`) and read from disk, then rendered with
 * the same Mustache-flavoured engine as the agent prompts — so it
 * supports `{{include:<rel>}}`, `{{#key}}…{{/key}}` conditional blocks
 * and `{{key}}` substitution. Use this for context that Sediment
 * assembles deterministically in code (e.g. the external-agent prompt)
 * where the surrounding prose should live next to the prompt tree
 * rather than being string-concatenated in a service file.
 *
 * Throws (via {@link resolveTemplateInclude}-style checks) on path
 * traversal / absolute paths / missing files so a typo fails loudly at
 * the call site. The trailing newline is stripped — callers control
 * their own separators.
 */
export function renderPromptFile(
  relPath: string,
  vars: Record<string, string> = {},
): string {
  const trimmed = relPath.trim();
  if (!trimmed) {
    throw new Error(
      `[agent-loader] renderPromptFile requires a non-empty path`,
    );
  }
  if (path.isAbsolute(trimmed)) {
    throw new Error(
      `[agent-loader] renderPromptFile path must be PROMPT-ROOT relative, not absolute: ${trimmed}`,
    );
  }
  const resolved = path.resolve(PROMPT_ROOT, trimmed);
  const inside = path.relative(PROMPT_ROOT, resolved);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(
      `[agent-loader] renderPromptFile path escapes the prompt root (${PROMPT_ROOT}): ${trimmed}`,
    );
  }
  if (!existsSync(resolved)) {
    throw new Error(
      `[agent-loader] renderPromptFile → file not found at ${resolved}`,
    );
  }
  const body = readFileSync(resolved, 'utf8');
  return renderTemplate(body, vars).replace(/\n$/, '');
}

// ─── Loader ─────────────────────────────────────────────────────────────────
//
// Parsing is done once per process (AGENT.md does not change at
// runtime); rendering happens on every `loadAgent()` call so the
// `{{skillCatalogue}}` substitution picks up freshly written user
// skills. The skill loader already implements a per-workspace,
// mtime-aware cache with a 2 s TTL and an `invalidateUserSkill(id)`
// hook — see `prompt/skills/loader.ts` — so re-rendering here
// transparently inherits that freshness contract.

/**
 * Cheap, parsed shell of an AGENT.md. Held in `_cache` and consulted
 * on every `loadAgent()`; the system prompt body is re-rendered
 * against the live skill catalogue on each access.
 */
interface ParsedAgent {
  fm: AgentFrontmatter;
  /** Markdown body with leading whitespace stripped, un-rendered. */
  body: string;
  sourcePath: string;
}

function parseAgentFile(id: AgentId): ParsedAgent {
  const sourcePath = path.join(AGENTS_DIR, id, 'AGENT.md');
  if (!existsSync(sourcePath)) {
    throw new Error(`[agent-loader] AGENT.md not found at ${sourcePath}`);
  }
  const raw = readFileSync(sourcePath, 'utf8');
  const { meta, content } = parseFrontmatter(raw);
  if (!meta || Object.keys(meta).length === 0) {
    throw new Error(
      `[agent-loader] ${sourcePath}: missing or empty YAML frontmatter`,
    );
  }
  const fm = validateFrontmatter(meta, sourcePath, id);
  return { fm, body: content.trimStart(), sourcePath };
}

/** Render a parsed agent into a `LoadedAgent` with fresh catalogues. */
function renderLoadedAgent(
  parsed: ParsedAgent,
  // Reserved for future per-canvas template vars; currently unused
  // (skill catalogue is workspace-scoped, memory rules moved to a
  // standalone skill).
  _opts: { canvasId?: string | null } = {},
): LoadedAgent {
  const skillCatalogue = parsed.fm.skillScope
    ? getSkillCatalogue(parsed.fm.skillScope)
    : '';
  const systemPrompt = renderTemplate(parsed.body, {
    skillCatalogue,
  }).trimEnd();
  return {
    id: parsed.fm.id,
    name: parsed.fm.name,
    description: parsed.fm.description,
    systemPrompt,
    toolNames: parsed.fm.tools,
    runtime: parsed.fm.runtime ?? {},
    messageTemplates: parsed.fm.messageTemplates ?? {},
    sourcePath: parsed.sourcePath,
  };
}

// ─── Cache ──────────────────────────────────────────────────────────────────
//
// Holds the *parsed* AGENT.md shell (frontmatter + raw body). The
// system prompt is rendered on top of this shell on every
// `loadAgent()` call so the catalogue stays in sync with the live
// user-skill set.

let _cache: Map<AgentId, ParsedAgent> | null = null;

function ensureCache(): Map<AgentId, ParsedAgent> {
  if (_cache) return _cache;
  _cache = new Map();
  return _cache;
}

/** Force a re-parse on next access. Intended for tests / future hot-reload. */
export function invalidateAgentCache(): void {
  _cache = null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load the configuration for an agent.
 *
 * AGENT.md is parsed once per process; the system prompt is rendered
 * against the *current* skill + memory catalogues on every call so
 * newly written user skills and memory size changes appear without
 * a restart. The skill loader already de-dupes filesystem work via
 * mtime + a 2 s TTL.
 *
 * Pass `opts.canvasId` (the request's active canvas) so the memory
 * catalogue can include the per-canvas canvas-memory line; omit it
 * for agents that aren't bound to a canvas (intent / sketch /
 * memory curator) and only the workspace-memory line will render.
 */
export function loadAgent(
  id: AgentId,
  opts: { canvasId?: string | null } = {},
): LoadedAgent {
  if (!VALID_AGENT_IDS.has(id)) {
    throw new Error(`[agent-loader] unknown agent id: ${id}`);
  }
  const cache = ensureCache();
  let parsed = cache.get(id);
  if (!parsed) {
    parsed = parseAgentFile(id);
    cache.set(id, parsed);
  }
  return renderLoadedAgent(parsed, opts);
}
