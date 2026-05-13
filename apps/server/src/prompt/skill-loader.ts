/**
 * Skill loader — markdown SKILL.md files as the single source of truth.
 *
 * Skills live as directories under `<thisDir>/skills/<id>/SKILL.md` (the
 * "global" set, shipped with the server) and may be overridden per-canvas
 * at `<workspace>/<canvasDir>/skills/<id>/SKILL.md` (and any companion
 * `references/*.md` under that directory). The per-canvas resolution
 * lives in `resolveSkillPath` so the canvas FS sandbox can keep enforcing
 * its existing rules; this module only owns the global set.
 *
 * Bodies are read once at process start. Frontmatter must include:
 *   - id          string, must match the directory name
 *   - name        human-readable label
 *   - description short catalogue blurb
 *   - appliesTo   array of agent surfaces (ask | operate | annotation | external)
 * Optional:
 *   - triggers    string[] (catalogue ranking hints, unused in phase 1)
 *   - version     number
 *
 * Validation failures throw at load time so a malformed skill cannot
 * ship silently.
 *
 * Runtime layout:
 *   - Dev (tsx) and start (tsx) both run from `src/`, so the relative
 *     `<thisDir>/skills/<id>/SKILL.md` layout works.
 *   - `tsc -p` is used only for typecheck today; if a real `dist/` build
 *     is added later, the build step must copy `src/prompt/skills/**\/*.md`
 *     into `dist/prompt/skills/`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../modules/storage/frontmatter.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Agent surfaces a skill is intended for.
 *
 * `ask` / `operate` mirror the public `AgentMode` enum from
 * `@sediment/shared`; `annotation` is the annotation-intent
 * pipeline; `external` is reserved for skills that should also be
 * advertised to external agents (Copilot / Codex / Claude Code).
 */
export type SkillScope = 'ask' | 'operate' | 'annotation' | 'external';

export interface SkillFrontmatter {
  id: string;
  name: string;
  description: string;
  appliesTo: SkillScope[];
  triggers?: string[];
  version?: number;
}

export interface LoadedSkill extends SkillFrontmatter {
  /** Markdown body with the YAML frontmatter block stripped. */
  body: string;
  /** Absolute path of the SKILL.md file on disk. */
  sourcePath: string;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the global skills directory (`src/prompt/skills`). */
export const GLOBAL_SKILLS_DIR = path.join(HERE, 'skills');

// ─── Loader ─────────────────────────────────────────────────────────────────

const REQUIRED_FRONTMATTER_KEYS = [
  'id',
  'name',
  'description',
  'appliesTo',
] as const;

const VALID_SCOPES: ReadonlySet<SkillScope> = new Set<SkillScope>([
  'ask',
  'operate',
  'annotation',
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

  const id = String(raw.id);
  if (id !== expectedId) {
    throw new Error(
      `[skill-loader] ${sourcePath}: frontmatter id "${id}" does not match directory name "${expectedId}"`,
    );
  }

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

  return {
    id,
    name: String(raw.name),
    description: String(raw.description),
    appliesTo,
    triggers,
    version,
  };
}

/** Load a single SKILL.md file. */
function loadSkillFile(sourcePath: string, expectedId: string): LoadedSkill {
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
  };
}

/** Scan the global skills directory and return one entry per `<id>/SKILL.md`. */
function scanGlobalSkills(): LoadedSkill[] {
  if (!existsSync(GLOBAL_SKILLS_DIR)) return [];
  const entries = readdirSync(GLOBAL_SKILLS_DIR, { withFileTypes: true });
  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(GLOBAL_SKILLS_DIR, entry.name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    skills.push(loadSkillFile(skillFile, entry.name));
  }
  // Stable order so the catalogue stays deterministic across processes.
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return skills;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

let _cache: Map<string, LoadedSkill> | null = null;

function ensureCache(): Map<string, LoadedSkill> {
  if (_cache) return _cache;
  const built = new Map<string, LoadedSkill>();
  for (const skill of scanGlobalSkills()) {
    built.set(skill.id, skill);
  }
  _cache = built;
  return built;
}

/** Force a re-scan on next access. Intended for tests / future hot-reload. */
export function invalidateSkillCache(): void {
  _cache = null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** All loaded skills, optionally filtered by agent surface. */
export function listSkills(scope?: SkillScope): LoadedSkill[] {
  const all = [...ensureCache().values()];
  if (!scope) return all;
  return all.filter((s) => s.appliesTo.includes(scope));
}

/** Get one skill by id. */
export function getSkill(id: string): LoadedSkill | undefined {
  return ensureCache().get(id);
}

/**
 * Resolve a `read("skills/<id>/...")` path against per-canvas overrides
 * first, then the global skill set. Returns the absolute file path or
 * `null` if neither layer has it.
 *
 * Supported forms:
 *   - `skills/<id>/SKILL.md`        → the skill's entry-point markdown.
 *   - `skills/<id>/<subpath>`       → arbitrary file under the skill
 *                                     directory (typically `references/foo.md`).
 *                                     The `<subpath>` is resolved within the
 *                                     skill directory and must not escape it
 *                                     via `..` segments — escapes throw
 *                                     `SkillPathEscapeError` so callers can
 *                                     surface the security violation as a
 *                                     distinct error from "not found".
 *
 * Per-canvas resolution is delegated to a caller-supplied probe so this
 * module stays free of canvas FS / sandbox dependencies (avoiding a
 * cycle with `tools/handlers/fs-sandbox.ts`).
 */
export class SkillPathEscapeError extends Error {
  constructor(rel: string) {
    super(`Skill path "${rel}" escapes the skill directory.`);
    this.name = 'SkillPathEscapeError';
  }
}

export function resolveSkillPath(
  rel: string,
  perCanvasProbe?: (rel: string) => string | null,
): string | null {
  if (perCanvasProbe) {
    const local = perCanvasProbe(rel);
    if (local) return local;
  }

  // Match: `skills/<id>/<subpath>` (subpath non-empty).
  // The legacy flat form `skills/<id>.md` was retired with Phase 3; every
  // prompt now references `skills/<id>/SKILL.md` and per-canvas overrides
  // live under the same directory layout.
  const m = rel.match(/^skills\/([^/]+)\/(.+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const skill = ensureCache().get(m[1]);
  if (!skill) return null;

  // Resolve `<subpath>` under the skill directory. Reject any path that
  // escapes via `..` segments — the canvas FS sandbox already does this
  // for per-canvas paths, but the global skill dir lives outside that
  // sandbox so we enforce it here too.
  const skillDir = path.dirname(skill.sourcePath);
  const resolved = path.resolve(skillDir, m[2]);
  if (resolved !== skillDir && !resolved.startsWith(skillDir + path.sep)) {
    throw new SkillPathEscapeError(rel);
  }
  if (!existsSync(resolved)) return null;
  const stat = statSync(resolved);
  if (!stat.isFile()) return null;
  return resolved;
}

// ─── Helpers (used by tests / migration) ────────────────────────────────────

/** Return the parsed body of a skill (without the frontmatter block). */
export function getSkillBody(id: string): string | null {
  return ensureCache().get(id)?.body ?? null;
}

/** Validate the global skill directory eagerly (call once at boot). */
export function preloadSkills(): void {
  ensureCache();
}
