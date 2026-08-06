---
name: review-agent-primitives
description: "Review the quality of an agent's tool descriptions, system/agent prompts, or SKILL.md files against current agent-engineering best practices. USE WHEN asked to review, audit, critique, score, or improve a tool description, agent prompt, system prompt, or skill; when a tool is called with wrong parameters or not called when it should be; when an agent makes redundant or repeated tool calls; or before shipping a new tool/prompt/skill; or when deciding which primitive a behavior belongs in (tool vs system prompt vs skill). Reviews the three artifacts together so shared context, overlap, and contradictions are caught."
---

# Review Agent Primitives

Evaluate three artifacts that steer an agent's behavior — **tool descriptions**, **agent/system prompts**, and **skills (SKILL.md)** — against a single, source-backed rubric. Reviews all three with one shared foundation so overlap, contradictions, and duplicated context are caught in one pass.

## When to use

- Reviewing / auditing / scoring a tool description, agent or system prompt, or a `SKILL.md`.
- Diagnosing behavior: a tool is called with wrong params, not called when it should be, or the agent makes redundant tool calls / burns turns guessing.
- Deciding placement: given a piece of behavior or context, which primitive it belongs in (system prompt vs tool vs skill), and flagging content that currently sits in the wrong one.
- Pre-ship polish of any of the three artifacts.

## When NOT to use

- Writing the artifact from scratch (do that first, then review).
- Reviewing application/business logic — that is a normal code review.

## Shared foundation (applies to all three)

These five principles come from the "context engineering" line of thinking and cut across every artifact. Score them once, here, before diving into the type-specific rubric — do not repeat them per section.

1. **Minimal high-signal tokens.** Find the smallest set of tokens that fully specifies the behavior. `minimal ≠ short`: include everything the reader needs, nothing it doesn't. Cut restated rules, filler, and dead caveats.
2. **Right altitude.** Avoid the two failure modes: (a) brittle hardcoded if-else logic that tries to script every case, and (b) vague high-level guidance that assumes shared context the model doesn't have. Aim for specific-but-flexible heuristics.
3. **Zero ambiguity → zero guessing.** Every implicit assumption (formats, niche terms, resource relationships, boundaries) must be explicit. Ambiguity is what causes the agent to guess wrong and spend extra tool-call turns. Name things unambiguously (`user_id`, not `user`).
4. **Self-consistency.** The artifact must not contradict itself, the system prompt, or a sibling tool/skill. If a human expert can't say which tool/instruction applies in a situation, the agent can't either.
5. **Fail-safe by design (poka-yoke).** Prefer constraints, examples, and actionable error text that make mistakes hard to make, over prose that merely warns against them.
6. **Discoverable & load-on-demand.** The `name`/`description` (for a skill) and the name/description (for tool search) are the discovery surface — keyword-rich and distinctive. For large tool/skill libraries, defer loading and keep only the few highest-use items resident, so context isn't spent on definitions the task doesn't need.

## Review workflow

1. **Identify the artifact type.** Tool description → prompt → skill. If mixed (e.g. a skill that also defines tools, or a prompt with an embedded tool spec), review each part with its own rubric.
2. **Score the shared foundation** (6 principles above) → `Pass / Warn / Fail` each.
3. **Load the matching reference rubric** and score its items:
   | Artifact | Reference |
   |----------|-----------|
   | Tool description / spec | [references/tool-description.md](references/tool-description.md) |
   | Agent / system prompt | [references/agent-prompt.md](references/agent-prompt.md) |
   | Skill (`SKILL.md`) | [references/skill-quality.md](references/skill-quality.md) |
4. **When all three exist together**, additionally check cross-artifact issues: duplicated context across prompt and tool descriptions, procedures restated in the system prompt that belong in a skill, tools the prompt references but doesn't scope, and name/description keywords that collide between skills or similar tools. Also check **same-type fan-out**: one fact restated across files of the _same_ type — a tool description and its own parameter/field-schema `description` strings, a `SKILL.md` and its sibling reference files, or two peer skills. The cross-artifact-type lens misses these because both copies are the same type; grep the distinctive phrase to find every copy, then flag lockstep-sync risk (see the fan-out signal under Placement mode).
5. **Report** using the output format below.

## Placement mode (which primitive should this live in?)

Trigger this when the ask is "where should this go?" rather than "is this good?", or whenever a review surfaces content sitting in the wrong artifact. Decide with the table, then recommend moving misplaced content to its correct owner.

| Put it in…                                 | When the content is…                                                                                                                                               | Keep OUT                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **System prompt / always-on instructions** | Global behavior, constraints, tone, refusal style; small, stable "always do X" policies that apply every turn                                                      | Long multi-step procedures — they bloat every turn and go brittle                                 |
| **Tool**                                   | An action on the world: calls external services/DBs, creates side effects, fetches live state. Narrowly scoped, strongly-typed inputs, explicit side effects       | Static procedural knowledge; anything with no side effect                                         |
| **Skill (`SKILL.md`)**                     | A reusable, multi-step _procedure_; branching/conditional workflow; needs scripts/templates/assets; used _sometimes_, not every turn; wants independent versioning | One-off tasks; always-on policy; pure live-data fetch                                             |
| **Few-shot examples**                      | Canonical, diverse demonstrations of expected behavior                                                                                                             | Exhaustive edge-case dumps. Workflow-specific examples belong in the skill, not the system prompt |

Decision signals:

- Needed every turn + short + stable → system prompt.
- Has a side effect or needs live state → tool.
- Multi-step / branching / needs code or assets / only sometimes → skill.
- Same content appears in two places → converge to a single owner (prefer the most specific: skill > instructions).
- **Same fact fanned out across many _same-type_ files** (tool desc + its field-schema `description`s, a `SKILL.md` + its `references/`, two peer skills) → this is a maintainability/lockstep-sync smell, not a type-placement question. Converge to one canonical statement + pointers **unless** the copies genuinely diverge by audience/execution path — then keep them but call out that they must change together, and make sure the review surface actually includes every copy (e.g. schema files, not just the tool-definition file). When the fanned-out fact is a machine-derivable enumeration (e.g. a prose list of command/variant names mirroring a schema union), the strongest form of "converge" is to derive it from the schema (codegen or a compile-time guard) so the copies cannot drift at all.
- A whole procedure sitting in the system prompt → move it to a skill (preserves reuse, versioning, and on-demand loading).

## Scoring model

Each checklist item gets one verdict, with a concrete finding that quotes the exact offending line:

- **Pass** — meets the bar.
- **Warn** — works but costs tokens, invites guessing, or will age badly.
- **Fail** — will cause wrong/failed/redundant calls or mis-triggering. Must fix.

Do not invent numeric scores per line; aggregate to one headline verdict per dimension.

## Output format

Always produce, in this order:

1. **Verdict line** — `Pass / Warn / Fail` overall + the single highest-impact issue (reference it by ID, e.g. `F1`).
2. **Findings table** — `ID | Dimension | Verdict | Evidence (quoted line) | Fix`. Give every issue a stable ID: `F1, F2, …` for each **Fail** and `W1, W2, …` for each **Warn**, numbered in order of impact. Pass rows need no ID.
3. **Prioritized fixes** — reference findings by ID (`F1 → …`), ordered by impact on wrong/redundant tool calls first (all `F` before any `W`).
4. **Rewrite** — only if asked, provide the corrected artifact.

Keep evidence quotes short. One row per real issue; do not pad the table to look thorough.
