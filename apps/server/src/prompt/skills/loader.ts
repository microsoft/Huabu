/**
 * Skill loader — markdown SKILL.md files as the single source of truth.
 *
 * Two sources coexist:
 *
 *   - **system** skills (shipped with the server): live under
 *     `<thisDir>/<id>/SKILL.md` (where `<thisDir>` is
 *     `src/prompt/skills/`). Loaded once at boot, cached for the
 *     lifetime of the process.
 *
 *   - **user** skills (workspace-owned, user- and memory-agent-editable):
 *     live under `<workspace>/setting/skills/<id>/SKILL.md`. The user
 *     can hand-edit these; the memory sub-agent may also write to them
 *     via `fs_write({ path: "skills/<id>/SKILL.md", ... })`. Either
 *     path makes them mutable at runtime, so this layer is cached
 *     per-workspace with mtime tracking and a short TTL.
 *
 * When the same `id` exists in both sources they are **merged** rather
 * than overridden. See {@link mergeSkill}.
 *
 * Frontmatter must include:
 *   - name        human-readable label
 *   - description short catalogue blurb
 *   - appliesTo   array of agent surfaces (ask | operate | sketch | external)
 * Optional:
 *   - triggers    string[] (catalogue ranking hints, unused in phase 1)
 *   - version     number
 *
 * The skill `id` is derived from the directory name — it is **not** a
 * frontmatter key. A stray `id:` in frontmatter is ignored.
 *
 * System-skill validation failures throw at load time so a malformed
 * shipped skill cannot ship silently. User-skill validation failures
 * are *logged and skipped* — a bad user-authored file must never
 * brick the agent.
 *
 * Runtime layout:
 *   - Dev (tsx) and start (tsx) both run from `src/`, so the relative
 *     `<thisDir>/<id>/SKILL.md` layout works.
 *   - `tsc -p` is used only for typecheck today; if a real `dist/` build
 *     is added later, the build step must copy `src/prompt/skills/**\/SKILL.md`
 *     (and any `references/`) into `dist/prompt/skills/`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { userSkillsDir } from '../../modules/storage/paths.js';
import { getWorkspacePath } from '../../modules/workspace.js';
import { getLogger } from '../../utils/logger.js';
import { parseFrontmatter } from '../../utils/markdown-frontmatter.js';

const log = getLogger('skill-loader');

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Agent surfaces a skill is intended for.
 *
 * `ask` / `operate` mirror the public `AgentMode` enum from
 * `@sediment/shared`; `sketch` is the sketch-intent
 * pipeline; `external` is reserved for skills that should also be
 * advertised to external agents (Copilot / Codex / Claude Code).
 */
export type SkillScope = 'ask' | 'operate' | 'sketch' | 'external';

/**
 * Where a `LoadedSkill` came from. Surfaced in the catalogue so the
 * user can tell at a glance which entries are system-owned vs.
 * user / AI-authored vs. extended (system + user merged).
 */
export type SkillSource = 'system' | 'user' | 'merged';

export interface SkillFrontmatter {
  id: string;
  name: string;
  description: string;
  appliesTo: SkillScope[];
  triggers?: string[];
  version?: number;
  /**
   * Opt this skill into the user-invokable `/` slash menu even when
   * `source === 'system'`. Defaults to `false` — most system skills
   * stay catalogue-only and are loaded autonomously by the agent.
   *
   * Use this for system skills that are essentially user-facing
   * commands (e.g. `create-skill`, `update-skill`): the menu becomes
   * their canonical entry point, and explicit invocation forces the
   * body into context regardless of whether the agent would have
   * discovered it on its own.
   *
   * `user` / `merged` skills are always user-invokable — this flag
   * has no effect on them.
   */
  userInvokable?: boolean;
}

export interface LoadedSkill extends SkillFrontmatter {
  /** Markdown body with the YAML frontmatter block stripped. */
  body: string;
  /**
   * Absolute path of the SKILL.md file on disk.
   *
   * For `source === 'merged'` this is the **system** SKILL.md path —
   * the merged body is assembled in memory. Callers that need the
   * user-side path for write-back must go through `userSkillPath()`.
   */
  sourcePath: string;
  /** Origin layer this entry came from. */
  source: SkillSource;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path of the system skills directory.
 *
 * Naming note: previously called `GLOBAL_SKILLS_DIR`; renamed to
 * `SYSTEM_SKILLS_DIR` to make the system / user distinction explicit
 * in the codebase.
 *
 * Two runtime layouts (see the parallel comment in `agents/loader.ts`):
 *   ─ Source (tsx): `HERE = src/prompt/skills/`, use it directly.
 *   ─ Bundled (tsup): all loaders collapse into one bundle so
 *     `HERE = dist-bundle/`. The build's `onSuccess` step copies
 *     `src/prompt/` to `dist-bundle/prompt/`, so we re-root onto
 *     `dist-bundle/prompt/skills/` when that subdir exists.
 */
const BUNDLED_SKILLS_DIR = path.join(HERE, 'prompt', 'skills');
export const SYSTEM_SKILLS_DIR = existsSync(BUNDLED_SKILLS_DIR)
  ? BUNDLED_SKILLS_DIR
  : HERE;

// `userSkillPath()` (the write-back target for `fs_write` on a
// `skills/<id>/SKILL.md` path) lives in the memory module — see
// `modules/agent/memory/sandbox.ts` + `writers.ts`. Keeping it out of
// the loader means the loader does not need to expose write paths; the
// user-side root is owned by `userSkillsDir()` in `workspace/disk/paths.ts`.

// ─── Validation ─────────────────────────────────────────────────────────────

const REQUIRED_FRONTMATTER_KEYS = ['name', 'description', 'appliesTo'] as const;

const VALID_SCOPES: ReadonlySet<SkillScope> = new Set<SkillScope>([
  'ask',
  'operate',
  'sketch',
  'external',
]);

/** Normalise a frontmatter object into a strict `SkillFrontmatter`. */
function validateFrontmatter(
  raw: Record<string, unknown>,
  sourcePath: string,
  expectedId: string,
): SkillFrontmatter {
  for (const key of REQUIRED_FRONTMATTER_KEYS) {
    if (raw[key] === undefined || raw[key] === null) {
      throw new Error(
        `[skill-loader] ${sourcePath}: missing required frontmatter key "${key}"`,
      );
    }
  }

  // The directory name is the single source of truth for the id. Any
  // `id:` in frontmatter is ignored (it used to be required and had to
  // match the directory name — now it is simply redundant).
  const id = expectedId;

  const appliesToRaw = Array.isArray(raw.appliesTo) ? raw.appliesTo : null;
  if (!appliesToRaw || appliesToRaw.length === 0) {
    throw new Error(
      `[skill-loader] ${sourcePath}: appliesTo must be a non-empty array`,
    );
  }
  const appliesTo: SkillScope[] = [];
  for (const scope of appliesToRaw) {
    const v = String(scope);
    if (!VALID_SCOPES.has(v as SkillScope)) {
      throw new Error(
        `[skill-loader] ${sourcePath}: invalid appliesTo entry "${v}". Allowed: ${[...VALID_SCOPES].join(', ')}`,
      );
    }
    appliesTo.push(v as SkillScope);
  }

  const triggers = Array.isArray(raw.triggers)
    ? raw.triggers.map((t) => String(t))
    : undefined;
  const version = typeof raw.version === 'number' ? raw.version : undefined;
  // Optional boolean. Treat anything that isn't an explicit `true` as
  // `false` (the menu-gating default) so a typo or stray string in
  // user content can't accidentally surface a non-invokable skill.
  const userInvokable = raw.userInvokable === true ? true : undefined;

  return {
    id,
    name: String(raw.name),
    description: String(raw.description),
    appliesTo,
    triggers,
    version,
    userInvokable,
  };
}

/** Load a single SKILL.md file. Throws on invalid frontmatter. */
function loadSkillFile(
  sourcePath: string,
  expectedId: string,
  source: SkillSource,
): LoadedSkill {
  const raw = readFileSync(sourcePath, 'utf8');
  const { meta, content } = parseFrontmatter(raw);
  if (!meta || Object.keys(meta).length === 0) {
    throw new Error(
      `[skill-loader] ${sourcePath}: missing or empty YAML frontmatter`,
    );
  }
  const fm = validateFrontmatter(meta, sourcePath, expectedId);
  return {
    ...fm,
    body: content.trimStart(),
    sourcePath,
    source,
  };
}

// ─── System cache (once-and-done) ──────────────────────────────────────────

/**
 * Scan the system skills directory.
 *
 * Skips any entry literally named `references/` so future shared
 * reference material at the top level would not be mistaken for a
 * skill. Also skips dotfiles defensively.
 */
function scanSystemSkills(): LoadedSkill[] {
  if (!existsSync(SYSTEM_SKILLS_DIR)) return [];
  const entries = readdirSync(SYSTEM_SKILLS_DIR, { withFileTypes: true });
  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const skillFile = path.join(SYSTEM_SKILLS_DIR, entry.name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    skills.push(loadSkillFile(skillFile, entry.name, 'system'));
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return skills;
}

let _systemCache: Map<string, LoadedSkill> | null = null;

function ensureSystemCache(): Map<string, LoadedSkill> {
  if (_systemCache) return _systemCache;
  const built = new Map<string, LoadedSkill>();
  for (const skill of scanSystemSkills()) built.set(skill.id, skill);
  _systemCache = built;
  return built;
}

// ─── User cache (per-workspace, mtime-aware, short-TTL) ────────────────────

interface UserCacheEntry {
  skill: LoadedSkill;
  /** `statSync(SKILL.md).mtimeMs` at the time we last parsed the file. */
  mtimeMs: number;
}

/** Workspace path that the current `_userCache` was built against. */
let _userCacheWorkspace: string | null = null;
let _userCache: Map<string, UserCacheEntry> | null = null;
let _userCacheLastScanMs = 0;

/**
 * Throttle directory scans. Within this window we trust the existing
 * cache without re-running `readdirSync` / `statSync`. Tuned to:
 *   - swallow the rapid-fire `read("skills/...")` calls a single agent
 *     turn might make,
 *   - while staying fresh enough that the memory sub-agent (which calls
 *     {@link invalidateUserSkill} on write) and external edits feel
 *     instant in practice.
 */
const USER_SCAN_TTL_MS = 2000;

/**
 * Resolve the active workspace path defensively.
 *
 * The skill loader is consulted from contexts where a workspace may
 * not yet be activated (e.g. early boot, tests that never call
 * `setWorkspacePath`). In those cases we degrade to "no user skills"
 * rather than throwing — system skills must still work.
 */
function tryGetWorkspace(): string | null {
  try {
    return getWorkspacePath();
  } catch {
    return null;
  }
}

/**
 * Re-scan the user skills directory and reconcile the cache.
 *
 * Strategy: list every `<id>/SKILL.md`, compare `mtimeMs` against the
 * cache, re-parse only entries that changed. Drop entries whose files
 * vanished. A bad frontmatter triggers a `console.warn` and the entry
 * is excluded from the result — never throw, never let one bad user
 * skill brick the loader.
 */
function rescanUserSkills(
  workspace: string,
  prev: Map<string, UserCacheEntry>,
): Map<string, UserCacheEntry> {
  // `userSkillsDir()` reads the *current* workspace path; we pass
  // `workspace` separately so the workspace-switch guard in
  // `ensureUserCache` controls cache identity, but the actual root
  // computation stays in `paths.ts` (single source of truth for the
  // `setting/skills/` segment).
  void workspace;
  const root = userSkillsDir();
  if (!existsSync(root)) return new Map();

  const entries = readdirSync(root, { withFileTypes: true });
  const next = new Map<string, UserCacheEntry>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const id = entry.name;
    const file = path.join(root, id, 'SKILL.md');
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const cached = prev.get(id);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      next.set(id, cached);
      continue;
    }

    try {
      const skill = loadSkillFile(file, id, 'user');
      next.set(id, { skill, mtimeMs: stat.mtimeMs });
    } catch (err) {
      // User-authored content must never brick the loader. Log and
      // skip — the skill simply won't be advertised until the user
      // fixes it.
      log.warn(
        { id, err: (err as Error).message },
        'skipping invalid user skill',
      );
    }
  }
  return next;
}

/**
 * Ensure the user cache reflects the current workspace + on-disk state.
 *
 * - Re-keys on workspace switch (full rebuild).
 * - Throttles full re-scans via {@link USER_SCAN_TTL_MS}; pass
 *   `forceFresh=true` to bypass.
 */
function ensureUserCache(forceFresh = false): Map<string, UserCacheEntry> {
  const workspace = tryGetWorkspace();
  if (workspace === null) {
    _userCacheWorkspace = null;
    _userCache = new Map();
    return _userCache;
  }
  if (workspace !== _userCacheWorkspace) {
    _userCacheWorkspace = workspace;
    _userCache = new Map();
    _userCacheLastScanMs = 0;
  }
  const now = Date.now();
  if (
    !forceFresh &&
    _userCache &&
    now - _userCacheLastScanMs < USER_SCAN_TTL_MS
  ) {
    return _userCache;
  }
  _userCache = rescanUserSkills(workspace, _userCache ?? new Map());
  _userCacheLastScanMs = now;
  return _userCache;
}

// ─── Merge ─────────────────────────────────────────────────────────────────

/**
 * Header inserted between system body and user body in a merged skill.
 *
 * Kept as a constant so future tooling (write-back, lint, tests) can
 * recognise the boundary deterministically.
 */
const USER_EXTENSION_HEADER = '\n\n---\n\n## User extensions\n\n';

/**
 * Combine a system skill and a user skill that share the same id.
 *
 * Frontmatter: bundle bundled (heh) as the base, let user override
 * scalar fields, union the array fields (`appliesTo`, `triggers`).
 * Body: system first, then a divider header, then the user body.
 * Description gains a `(extended)` suffix so the catalogue makes the
 * extension visible.
 */
function mergeSkill(system: LoadedSkill, user: LoadedSkill): LoadedSkill {
  const appliesTo: SkillScope[] = Array.from(
    new Set<SkillScope>([...system.appliesTo, ...user.appliesTo]),
  );
  const triggersUnion = Array.from(
    new Set<string>([...(system.triggers ?? []), ...(user.triggers ?? [])]),
  );
  const triggers = triggersUnion.length > 0 ? triggersUnion : undefined;
  const description = `${user.description} (extended)`;
  const version = user.version ?? system.version;
  // Merged skills are user-authored extensions of a system skill, so
  // they are always user-invokable in practice — but propagate an
  // explicit `userInvokable: true` from either side too, so the flag
  // survives a future change where merged stops implying invokable.
  const userInvokable =
    user.userInvokable === true || system.userInvokable === true
      ? true
      : undefined;

  return {
    id: system.id,
    name: user.name || system.name,
    description,
    appliesTo,
    triggers,
    version,
    userInvokable,
    body: `${system.body}${USER_EXTENSION_HEADER}${user.body}`,
    // Source path points at the system file — the merged body only
    // exists in memory. Writers needing the user-side path go through
    // `userSkillPath(id)`.
    sourcePath: system.sourcePath,
    source: 'merged',
  };
}

/**
 * Build the visible, merged skill set: combine system + user, with
 * merging when the same id exists in both. Bundled-only and user-only
 * ids pass through unchanged with their own `source` label.
 */
function buildMergedView(): Map<string, LoadedSkill> {
  const sys = ensureSystemCache();
  const user = ensureUserCache();
  const merged = new Map<string, LoadedSkill>();
  for (const skill of sys.values()) merged.set(skill.id, skill);
  for (const entry of user.values()) {
    const s = merged.get(entry.skill.id);
    if (s) merged.set(s.id, mergeSkill(s, entry.skill));
    else merged.set(entry.skill.id, entry.skill);
  }
  return merged;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** All loaded skills, optionally filtered by agent surface. */
export function listSkills(scope?: SkillScope): LoadedSkill[] {
  const all = [...buildMergedView().values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  if (!scope) return all;
  return all.filter((s) => s.appliesTo.includes(scope));
}

/** Get one skill by id (merged view: respects user / system / merged). */
export function getSkill(id: string): LoadedSkill | undefined {
  return buildMergedView().get(id);
}

/** Return the parsed body of a skill (without the frontmatter block). */
export function getSkillBody(id: string): string | null {
  return buildMergedView().get(id)?.body ?? null;
}

/** Force a re-scan of system skills on next access. Tests only. */
export function invalidateSkillCache(): void {
  _systemCache = null;
  _userCache = null;
  _userCacheWorkspace = null;
  _userCacheLastScanMs = 0;
}

/**
 * Force the user cache to re-read the given skill (or every user
 * skill when called without arguments) on the next access.
 *
 * Wired into:
 *   - `fs_write` on a `skills/<id>/SKILL.md` path after a successful
 *     write: pass the id so the very next `read("skills/<id>/SKILL.md")`
 *     sees fresh content without waiting for the TTL.
 *   - `setWorkspacePath()` after activation: invalidates everything
 *     so the new workspace's user skills replace the old ones.
 */
export function invalidateUserSkill(id?: string): void {
  if (id === undefined) {
    _userCache = null;
    _userCacheLastScanMs = 0;
    return;
  }
  if (_userCache) _userCache.delete(id);
  _userCacheLastScanMs = 0;
}

/** Validate the system skill directory eagerly (call once at boot). */
export function preloadSkills(): void {
  ensureSystemCache();
}

// ─── Path / content resolution for `read("skills/...")` ────────────────────

export class SkillPathEscapeError extends Error {
  constructor(rel: string) {
    super(`Skill path "${rel}" escapes the skill directory.`);
    this.name = 'SkillPathEscapeError';
  }
}

/**
 * Resolve a `skills/<id>/<subpath>` request to an absolute file path.
 *
 * Supported forms:
 *   - `skills/<id>/SKILL.md`        → the entry-point markdown of the
 *                                     skill, returned from whichever
 *                                     source has it. For merged skills
 *                                     the system path is returned;
 *                                     callers reading SKILL.md should
 *                                     prefer {@link readSkillFile}
 *                                     which yields the merged content.
 *   - `skills/<id>/<subpath>`       → arbitrary file under the skill's
 *                                     source directory (typically
 *                                     `references/foo.md`). The
 *                                     `<subpath>` is resolved within
 *                                     the skill directory and must not
 *                                     escape it via `..` segments —
 *                                     escapes throw
 *                                     {@link SkillPathEscapeError} so
 *                                     callers can surface the security
 *                                     violation as a distinct error
 *                                     from "not found".
 *
 * Resolution order for `references/*`: user directory first (when the
 * id exists user-side), then system directory (when the id exists
 * system-side). This lets the user / memory-agent ship references
 * alongside their extended skill body.
 */
export function resolveSkillPath(rel: string): string | null {
  const m = rel.match(/^skills\/([^/]+)\/(.+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const id = m[1];
  const sub = m[2];

  const userCache = ensureUserCache();
  const userEntry = userCache.get(id);
  const sysCache = ensureSystemCache();
  const sysSkill = sysCache.get(id);

  const candidates: Array<{ root: string; tag: string }> = [];
  if (userEntry) {
    candidates.push({
      root: path.dirname(userEntry.skill.sourcePath),
      tag: 'user',
    });
  }
  if (sysSkill) {
    candidates.push({ root: path.dirname(sysSkill.sourcePath), tag: 'system' });
  }
  if (candidates.length === 0) return null;

  for (const { root } of candidates) {
    const resolved = path.resolve(root, sub);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      // Treat ALL roots as a single conceptual skill directory: a `..`
      // escape against any of them is a security violation, full stop.
      throw new SkillPathEscapeError(rel);
    }
    if (!existsSync(resolved)) continue;
    const stat = statSync(resolved);
    if (!stat.isFile()) continue;
    return resolved;
  }
  return null;
}

/**
 * Resolve a `skills/<id>/<subpath>` request to its content as a string.
 *
 * Specifically for SKILL.md, this returns the **merged** view when
 * both layers carry the id — assembling the system + user body in
 * memory. For other files (typically `references/*`), this is a
 * convenience over {@link resolveSkillPath} + `readFileSync`.
 *
 * Returns `null` when the id / file is not found, mirroring
 * `resolveSkillPath`. Throws {@link SkillPathEscapeError} on `..`
 * traversal.
 *
 * Used by `read("skills/...")` in {@link ../../modules/agent/tools/handlers/fs-read.ts}
 * so the agent always sees the same merged view that the catalogue
 * advertised.
 */
export function readSkillFile(rel: string): string | null {
  const m = rel.match(/^skills\/([^/]+)\/(.+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const id = m[1];
  const sub = m[2];

  if (sub === 'SKILL.md') {
    const merged = buildMergedView().get(id);
    if (!merged) return null;
    // Reconstruct the SKILL.md verbatim: frontmatter + body.
    return serialiseSkill(merged);
  }

  const abs = resolveSkillPath(rel);
  if (!abs) return null;
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Serialise a `LoadedSkill` back into the on-disk markdown form
 * (YAML frontmatter + body). Used by {@link readSkillFile} so the
 * agent sees something indistinguishable from a real SKILL.md when
 * reading a merged skill — including the `description (extended)`
 * marker, the union'd `appliesTo`, etc.
 *
 * NOT a general-purpose YAML writer: only handles the small fixed
 * shape of `SkillFrontmatter`. Strings are wrapped in double quotes
 * with `\` and `"` escaped; arrays render inline. Adequate for what
 * we author here; if a future SKILL.md frontmatter grows complex
 * shapes we should switch to a real YAML lib.
 */
function serialiseSkill(skill: LoadedSkill): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${skill.id}`);
  lines.push(`name: ${yamlString(skill.name)}`);
  lines.push(`description: ${yamlString(skill.description)}`);
  lines.push(
    `appliesTo: [${skill.appliesTo.map((s) => yamlString(s)).join(', ')}]`,
  );
  if (skill.triggers && skill.triggers.length > 0) {
    lines.push(
      `triggers: [${skill.triggers.map((s) => yamlString(s)).join(', ')}]`,
    );
  }
  if (skill.version !== undefined) {
    lines.push(`version: ${skill.version}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${skill.body}`;
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
