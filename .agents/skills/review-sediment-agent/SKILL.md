---
name: review-sediment-agent
description: "Review the Sediment operate agent's three steering artifacts at their fixed repo locations — system prompt, tool descriptions, and skills. USE WHEN reviewing, auditing, or polishing the operate (or ask/intent/sketch) agent prompt, the agent tool definitions, or the canvas/memory skills; before shipping changes to AGENT.md, tool definitions.ts, or a skill. Thin Sediment-specific wrapper: it only locates the artifacts; all scoring rules come from review-agent-primitives."
---

# Review Sediment Agent

Sediment-specific entry point for reviewing this repo's agent primitives. It adds **only** the artifact locations. Every rubric, the scoring model, the output format, and the placement decision table live in the general skill — do not duplicate them here.

**Rules & rubric:** [review-agent-primitives](../review-agent-primitives/SKILL.md) plus its references:
[tool-description](../review-agent-primitives/references/tool-description.md) ·
[agent-prompt](../review-agent-primitives/references/agent-prompt.md) ·
[skill-quality](../review-agent-primitives/references/skill-quality.md).

## Artifact locations

| Artifact          | Path                                                                                                                              | Rubric to apply  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| System prompt     | `apps/server/src/prompt/agents/operate/AGENT.md` (same structure for `ask/`, `intent/`, `sketch/`)                                | agent-prompt     |
| Tool descriptions | `apps/server/src/modules/agent/tools/definitions.ts`                                                                              | tool-description |
| Skills            | `apps/server/src/prompt/skills/` — `canvas/`, `memory/`, `sketch-gestures/`, `create-skill/`, `update-skill/` (each a `SKILL.md`) | skill-quality    |

## How to review

1. **Read the general rubric first** (link above), then read the artifact(s) being reviewed at the paths above.
2. **Default to a combined review** of all three so cross-artifact and placement issues surface; do a single-artifact pass only if the user scopes it that way.
3. **Score** with the shared foundation + the matching reference rubric; run **Placement mode** whenever content looks misplaced.
4. **Report** using review-agent-primitives' output format (verdict → findings table → prioritized fixes → optional rewrite).

## Sediment cross-artifact checks

When reviewing more than one artifact together, pay special attention to:

- Tool descriptions in `definitions.ts` must not contradict the tool guidance in `AGENT.md`.
- Multi-step canvas procedures belong in `prompt/skills/`, not restated inside `AGENT.md`.
- Tools referenced by `AGENT.md` must exist and be scoped in `definitions.ts` (no dangling references).
- Skill `name`/`description` under `prompt/skills/` must not collide, and each must carry clear "use when / don't use when" triggers.
