---
name: review-huabu-agent
description: "Review the Huabu operate agent's three steering artifacts at their fixed repo locations — system prompt, tool descriptions, and skills. USE WHEN reviewing, auditing, or polishing the operate (or ask/intent/sketch) agent prompt, the agent tool definitions, or the canvas/memory skills; before shipping changes to AGENT.md, tool definitions.ts, or a skill. Thin Huabu-specific wrapper: it only locates the artifacts; all scoring rules come from review-agent-primitives."
---

# Review Huabu Agent

Huabu-specific entry point for reviewing this repo's agent primitives. It adds **only** the artifact locations. Every rubric, the scoring model, the output format, and the placement decision table live in the general skill — do not duplicate them here.

**Rules & rubric:** [review-agent-primitives](../review-agent-primitives/SKILL.md) plus its references:
[tool-description](../review-agent-primitives/references/tool-description.md) ·
[agent-prompt](../review-agent-primitives/references/agent-prompt.md) ·
[skill-quality](../review-agent-primitives/references/skill-quality.md).

## Artifact locations

| Artifact          | Path                                                                                                                                                                                                                                                                                      | Rubric to apply  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| System prompt     | `apps/server/src/prompt/agents/operate/AGENT.md` (same structure for `ask/`, `intent/`, `sketch/`)                                                                                                                                                                                        | agent-prompt     |
| Tool descriptions | `apps/server/src/modules/agent/tools/definitions.ts` plus the canonical canvas command/query Zod schemas in `packages/shared/src/types/api/space-operations.ts` — their `description` strings are load-bearing text the model reads at call time, so review them together, not separately | tool-description |
| Skills            | `apps/server/src/prompt/skills/` — `canvas/` (its `SKILL.md` **and** every file under `canvas/references/`), `memory/`, `sketch-gestures/`, `create-skill/`, `update-skill/`                                                                                                              | skill-quality    |

## How to review

1. **Read the general rubric first** (link above), then read the artifact(s) being reviewed at the paths above.
2. **Default to a combined review** of all three so cross-artifact and placement issues surface; do a single-artifact pass only if the user scopes it that way.
3. **Score** with the shared foundation + the matching reference rubric; run **Placement mode** whenever content looks misplaced.
4. **Report** using review-agent-primitives' output format (verdict → findings table → prioritized fixes → optional rewrite).

## Huabu cross-artifact checks

When reviewing more than one artifact together, pay special attention to:

- Tool descriptions in `definitions.ts` must not contradict the tool guidance in `AGENT.md`.
- Multi-step canvas procedures belong in `prompt/skills/`, not restated inside `AGENT.md`.
- Tools referenced by `AGENT.md` must exist and be scoped in `definitions.ts` (no dangling references).
- Skill `name`/`description` under `prompt/skills/` must not collide, and each must carry clear "use when / don't use when" triggers.
- **Same-fact fan-out (lockstep-sync smell).** One rule about the canvas often lives in _many same-type files at once_ — a `definitions.ts` tool desc **and** its `schemas/*.ts` field description, or a `SKILL.md` **and** its own `references/*.md`, or two sibling skills (`canvas/` vs `sketch-gestures/`). The cross-artifact-**type** checks above will not catch this because both copies are the same type. When you find one, trace every other file that states the same fact (grep the distinctive phrase), verify they don't drift or contradict after a change, and flag it as a `Warn`: converge to one canonical owner with a full statement + pointers, unless the copies genuinely diverge by audience/path (e.g. the chat "omit `id`" vs sketch "set explicit `id`" split) — in which case keep them but note that they must change in lockstep.
