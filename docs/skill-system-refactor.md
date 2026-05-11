# Skill System Refactor — Plan

> Move agent prompt knowledge out of TypeScript string constants into
> file-system-backed markdown SKILL files, so all agents (built-in
> Sediment, GitHub Copilot, Codex, Claude Code, …) learn the canvas
> the same way: by reading files.

## 1. Goals

1. **Single source of truth** for canvas knowledge. Stop maintaining the
   same description of `CREATE_NODES` / `read("nodes/<nodeId>.md")` /
   layout strategies in 3+ TypeScript prompt files.
2. **Cross-agent reusable**. External agents
   ([docs/external_agent_design.md](./external_agent_design.md)) get
   the same canvas mental model with zero special integration —
   they just `read` markdown files.
3. **No new tool surface**. The current `use_skill` tool is removed.
   Agents discover skills via the system-prompt catalogue and load
   them with the same `read` / `find` / `ls` they already use for
   node markdown.
4. **Data-driven**. Skill content is markdown + YAML frontmatter, not
   TypeScript. Adding / editing a skill is a markdown change, no rebuild.
5. **Few skills, layered depth**. The catalogue stays short. A skill is
   "one thing an agent might want to learn", not "one chunk of
   duplicated prose". Most agents see exactly one canvas-related skill;
   the depth lives behind references that the skill itself points to.
6. **Safe to roll out**. Phased migration; each phase is independently
   shippable and the old behaviour keeps working until its phase
   replaces it.

## 2. Decisions (locked in)

| #   | Decision                                                                                                          | Rationale                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Skills are global **and** per-canvas-overridable.                                                                 | Lets users / teams pin a custom layout style or domain glossary onto a single canvas without forking the global set.                                                                                         |
| D2  | Skill bodies do **not** inline zod / TypeBox schemas.                                                             | Schemas stay in [apps/server/src/modules/agent/tools/schemas/](../apps/server/src/modules/agent/tools/schemas/) as the only source of truth. Skills reference them by name (e.g. "see CREATE_NODES schema"). |
| D3  | The `use_skill` tool is **removed**. Agents load skills via `read`.                                               | Mirrors how Copilot / Codex / Claude Code consume `AGENTS.md`, `.cursor/rules/*.md`, etc. One mechanism, no new tool surface.                                                                                |
| D4  | Phase 4 ("ask-mode" / `system.ts`) is deferred.                                                                   | Low repetition, low value. Revisit after operate / annotation are migrated.                                                                                                                                  |
| D5  | One **core skill per agent surface**, not one skill per topic. Depth lives in `references/` next to the SKILL.md. | Mirrors Anthropic Skills / Cursor Rules / `CLAUDE.md` / `AGENTS.md`. Keeps the catalogue tiny, makes the entry point obvious, and prevents boundary drift between sibling "topic" skills.                    |
| D6  | Pipeline-specific knowledge gets its **own** skill, scope-gated via `appliesTo`.                                  | E.g. annotation gesture → command mapping is irrelevant to operate / chat / external agents — it should not show up in their catalogue or context.                                                           |

## 3. File layout

### 3.1 Global skills (ship with the server)

```
apps/server/src/prompt/skills/
  canvas/                              ← the only catalogue entry seen by
    SKILL.md                             operate / chat / external agents.
    references/                          Mental model + tool map + command
      layout-recipes.md                  reference. Loaded with
      command-cookbook.md                read("skills/canvas/SKILL.md").
  annotation/                          ← annotation pipeline only.
    SKILL.md                             Loaded with
                                         read("skills/annotation/SKILL.md").
```

Two skills total. `canvas` is the universal entry point; `annotation` is
gated to the annotation pipeline via `appliesTo: [annotation]` so it
does not pollute the operate / chat / external catalogues.

- Lives **inside `src/`** so it is colocated with the loader, available
  to both `tsx` (dev) and any future bundling.
- The loader resolves the directory via `fileURLToPath(import.meta.url)`,
  same pattern as [apps/server/src/load-env.ts](../apps/server/src/load-env.ts).
- A skill is **a directory** named after its `id`. It must contain
  `SKILL.md` (the entry point); it may contain `references/*.md`
  (deep-dive material the SKILL.md links to but does not require).

#### `references/` are not skills

Files under `references/` are **plain markdown** — no frontmatter,
not loaded by the skill scanner, not listed in the catalogue. They
exist only because `SKILL.md` points at them with explicit
`read("skills/<id>/references/<file>.md")` calls. This keeps:

- the loader simple (`*/SKILL.md` only);
- the catalogue small (one line per skill);
- the cost of adding a deep-dive low (drop a markdown file, link to it
  from SKILL.md — no schema, no rebuild).

### 3.2 Per-canvas overrides (optional)

```
<workspace>/<canvasId>/
  skills/
    canvas/
      SKILL.md           ← overrides the global canvas SKILL.md
      references/
        team-style.md    ← canvas-only deep-dive, no global counterpart
```

- Resolved by the canvas FS sandbox just like `nodes/`, so the same
  `read("skills/canvas/SKILL.md")` call works whether the file lives
  in the canvas folder or in the global skill dir (see §4.2).
- Phase 1 only **wires the resolution path**; Phase 5 may add UI for
  editing per-canvas skills.

### 3.3 SKILL.md format

```markdown
---
id: canvas
name: Canvas
description: Canvas mental model, tool map, and command reference.
appliesTo: [ask, operate, external] # which agent surfaces see this skill
triggers: [canvas, node, edge, frame] # optional ranking hints
version: 1
---

# Canvas

(prose: mental model, decision matrix, command reference, …)

## Deeper dives (optional)

- `read("skills/canvas/references/layout-recipes.md")` — opinionated
  layouts for flowcharts, mind maps, timelines, knowledge maps.
- `read("skills/canvas/references/command-cookbook.md")` — composed
  patterns: merge, brainstorm, organize, restyle a cluster, tidy a row.
```

Constraints:

- Required frontmatter keys: `id`, `name`, `description`, `appliesTo`.
- `appliesTo` is one or more of `ask | operate | annotation | external`.
  An empty / wrong value fails validation at boot.
- SKILL.md body should stay ≤ ~200 lines; anything longer goes into a
  `references/*.md` and gets linked from the "Deeper dives" section.
- `references/*.md` have no frontmatter, no length limit, no validation.

## 4. Runtime mechanics

### 4.1 Catalogue injection (system prompt)

The catalogue is the only metadata that goes into the prompt. It tells
the agent which skills exist; loading happens via `read`. After the
refactor, an operate-mode prompt sees:

```
## Available skills
- **canvas** — Canvas mental model, tool map, and command reference.

Load with: read("skills/<id>/SKILL.md"). Per-canvas overrides at
<canvas>/skills/<id>/SKILL.md take precedence over the global set.
```

The annotation pipeline's prompt sees only `annotation`. Catalogue
filtering is `appliesTo`-driven, so adding an annotation-only skill
will never leak into the operate prompt.

### 4.2 `read("skills/<id>/SKILL.md")` resolution

Extend [fs-sandbox.ts](../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts):

1. If `rel` starts with `skills/`, the resolver tries:
   1. `<workspace>/<canvasId>/<rel>` (per-canvas override — exact path
      match, including any `references/...` suffix).
   2. `<global skills dir>/<rel>` for the same path.
2. If neither exists, throw the usual "Path not found" error.

The resolver is **path-based, not skill-id-based**: it matches the
full canvas-relative path, so it transparently handles
`skills/canvas/SKILL.md`, `skills/canvas/references/layout-recipes.md`,
and any future nested file equally — the catalogue and the loader do
not need to know about references.

### 4.3 Loader

`apps/server/src/prompt/skill-loader.ts`:

- Scans every `<global skills dir>/<id>/SKILL.md` at process start,
  parses it with the existing `parseFrontmatter` helper.
- **Ignores** files outside `SKILL.md` (so `references/*.md` are not
  loaded as skills, only served by `read`).
- Validates required frontmatter keys + `appliesTo` enum; fails loudly
  so a malformed skill cannot ship silently.
- Exposes:
  - `listSkills(scope?: SkillScope): LoadedSkill[]` for the catalogue
  - `getSkill(id): LoadedSkill | undefined`
  - `resolveSkillPath(rel, perCanvasProbe?)` for `read`
  - `preloadSkills()` for boot-time fail-fast
- Hot-reload (dev-only) is a Phase-5 nice-to-have, not in this refactor.

### 4.4 Removing `use_skill`

- Drop `useSkillTool` from `chatTools` / `operateTools` in
  [definitions.ts](../apps/server/src/modules/agent/tools/definitions.ts).
- Delete [handlers/use-skill.ts](../apps/server/src/modules/agent/tools/handlers/use-skill.ts).
- Delete the `use_skill` switch arm in [executor.ts](../apps/server/src/modules/agent/tools/executor.ts).
- Update agent / annotation prompts to point at `read("skills/<id>/SKILL.md")`.

This happens in **Phase 2**, after the loader and read-resolver are in
place — so Phase 1 ships a backwards-compatible coexistence (loader +
read resolver active, `use_skill` still works pointing at the same
data).

## 5. Phased migration

### Phase 1 — Infrastructure (no prompt-content changes) ✓ DONE

- [x] `apps/server/src/prompt/skills/build-flowchart/SKILL.md` —
      migrate the existing `build-flowchart.ts` content verbatim.
- [x] `apps/server/src/prompt/skill-loader.ts` — directory scanner,
      frontmatter validation.
- [x] Refactor `apps/server/src/prompt/skills/index.ts` to delegate to
      the loader (legacy `SkillDefinition` / `SKILL_REGISTRY` shim).
- [x] Extend `fs-read.ts` with a skill-aware resolver (per-canvas
      override → global SKILL.md fallback).
- [x] Smoke test: `read("skills/build-flowchart.md")` and `use_skill`
      both return the same body.

### Phase 2 — Drop `use_skill`, extract two skills ✓ DONE (will be re-shaped in Phase 3)

- [x] Extract `canvas-commands` and `canvas-tools` SKILL files.
- [x] Trim the corresponding sections from `agent.ts` / `intent.ts` /
      `definitions.ts`.
- [x] Remove `use_skill` tool + handler + executor arm; reword catalogue.
- [x] `SKILL_REGISTRY` shim removed (no longer needed once `use_skill`
      is gone).

> **Re-shape note.** Phase 2 left us with three flat skills
> (`canvas-commands`, `canvas-tools`, `build-flowchart`). Phase 3
> consolidates them into the `canvas` core skill + `references/`
> structure described in §3, and adds the separate `annotation` skill.

### Phase 3 — Consolidate into `canvas` + `annotation` ✓ DONE

Goal: cut catalogue noise, eliminate boundary drift, give the
annotation pipeline its own scoped skill.

Output structure (matches §3.1):

```
skills/
  canvas/
    SKILL.md                               ← one entry point for ask/operate/external
    references/
      layout-recipes.md                    ← extends today's build-flowchart
      command-cookbook.md                  ← merge / brainstorm / organize / restyle
  annotation/
    SKILL.md                               ← gesture → command for annotation pipeline only
```

Steps:

- [x] Create `skills/canvas/SKILL.md` by merging the catalogue-worthy
      parts of today's `canvas-tools/SKILL.md` (decision matrix) and
      `canvas-commands/SKILL.md` (one-line command catalogue + ID
      conventions + batch order). End with the "Deeper dives" links to
      the two references.
- [x] Create `skills/canvas/references/command-cookbook.md` lifting the
      "Common patterns" table from `canvas-commands/SKILL.md` and
      expanding with brainstorm / merge / organize / restyle / tidy /
      ask-question / rewire / detach / anti-patterns recipes.
- [x] Create `skills/canvas/references/layout-recipes.md` merging the
      current `build-flowchart/SKILL.md` content with the "Layout
      strategies" block from [agent.ts](../apps/server/src/prompt/agent.ts),
      plus stub placeholders for mind-map / timeline / knowledge-map.
- [x] Create `skills/annotation/SKILL.md` (`appliesTo: [annotation]`)
      lifting the "Gesture interpretation" + "Rules" sections from
      [intent.ts](../apps/server/src/prompt/intent.ts), pointing at the
      shared canvas skill for canvas knowledge instead of duplicating it.
- [x] Extend `resolveSkillPath` to support `skills/<id>/<subpath>`
      (e.g. `skills/canvas/references/layout-recipes.md`), with
      `..`-escape defence; per-canvas override path stays unchanged.
- [x] Trim [agent.ts](../apps/server/src/prompt/agent.ts): drop the
      Layout strategies block, drop the inline canvas-commands /
      canvas-tools mentions; catalogue auto-renders to a single
      `canvas` line.
- [x] Trim [intent.ts](../apps/server/src/prompt/intent.ts) ANNOTATION
      prompt to: input contract + final-answer contract + a pointer
      block to `skills/annotation/SKILL.md` and `skills/canvas/SKILL.md`.
- [x] Update the `canvas_commands` tool description in
      [definitions.ts](../apps/server/src/modules/agent/tools/definitions.ts)
      so its skill link points at `skills/canvas/SKILL.md`.
- [x] Delete `skills/canvas-commands/`, `skills/canvas-tools/`,
      `skills/build-flowchart/`.
- [x] Verify: typecheck + lint (0 errors) + format. Smoke-tested
      `resolveSkillPath` against `SKILL.md` paths, both reference
      paths, missing files, `..` escape attempts, and unknown ids;
      catalogue filtering renders 1 line for `operate` / `ask` /
      `external` and 2 lines for `annotation`.

### Phase 4 — External-agent integration

- For SDK-based adapters (Copilot SDK), no `defineTool('sediment_use_skill')`
  is needed — they get the same `read` bridge. Adapters that cannot
  mount the canvas FS materialise the skills directory inside their
  working directory at session start (or expose it via a tiny MCP
  server — pick at adapter time).
- Ship an `AGENTS.md` (or equivalent agent-specific file) at the
  workspace root that says: "If you need to operate the Sediment
  canvas, start with `skills/canvas/SKILL.md`."

### Phase 5 — DX & governance

- CI lint: required frontmatter keys, SKILL.md line-count cap, unique
  `id`s, references must exist (every `read("skills/<id>/references/...")`
  in a SKILL.md resolves).
- Optional dev-only hot reload (`mtime` watch).
- Changelog entry: "Agent skills consolidated to a single `canvas`
  skill + references."

## 6. Backwards compatibility & rollback

- Phase 1 ✓ left the public surface unchanged: `SKILL_REGISTRY` and
  `getSkillCatalogue()` kept their signatures, just backed by FS scan
  instead of TS imports.
- Phase 2 ✓ was the breaking change (dropped `use_skill`). Rollback
  would mean restoring the tool definition + executor arm; the loader
  still feeds both pathways.
- Phase 3 is **content-only** (skill markdown rearrangement + prompt
  trims). No tool surface changes. Rollback = revert the commit; the
  loader and resolver are unaffected.
- The skill markdown files are the **canonical** source from Phase 1
  onwards. Do not re-introduce duplicate prose into `agent.ts` /
  `intent.ts` / tool descriptions after a skill / reference is
  extracted.

## 7. Open questions (track separately)

- **Skill versioning**: do we need `version` enforcement, or is editing
  the skill body enough? (Lean toward "no enforcement, just record".)
- **Per-canvas skill UI**: surface a "skills" panel inside the canvas
  inspector? Out of scope for this refactor.
- **External-agent skill discovery**: do we materialise into the bound
  code repo, or expose a tiny `sediment_skills` MCP server? Decide in
  Phase 4 once the adapter design lands.
