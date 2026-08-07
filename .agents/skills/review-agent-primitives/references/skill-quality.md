# Rubric: Skills (SKILL.md)

Score each item `Pass / Warn / Fail`. Ordered by impact on whether the skill triggers correctly and loads efficiently. Skip the shared-foundation principles (already scored in SKILL.md).

## 1. Progressive disclosure is respected (the core design principle)

Three levels; each should carry only what that level needs:

1. **Frontmatter `name` + `description`** — pre-loaded into the system prompt at startup. Just enough to decide _when_ to trigger. Nothing operational here.
2. **`SKILL.md` body** — loaded only once the skill is judged relevant. The core workflow.
3. **Bundled files** (`references/*.md`, scripts) — read on demand, only in the scenarios that need them.

- **Fail:** everything crammed into `SKILL.md`; or operational detail hidden in frontmatter; or rarely-used context inline that inflates every trigger.

## 2. `description` is the trigger surface (highest leverage)

- Must be keyword-rich and action-specific: what it does + explicit "USE WHEN…" triggers + boundaries ("NOT for…").
- If trigger phrases aren't literally in the description, the agent won't fire the skill — or fires the wrong one.
- Check for collisions with other installed skills' descriptions.
- **Bad:** "Helps with prompts." **Good:** "Review/audit/score a tool description, agent prompt, or SKILL.md; use when a tool is mis-called or an agent makes redundant calls."

## 3. Lean body, split for scale

- When `SKILL.md` grows unwieldy, move detail into separate referenced files.
- Keep mutually-exclusive or rarely-co-used paths in separate files so a given task pays only for what it loads.
- **Warn:** one long `SKILL.md` mixing several independent workflows.

## 4. Code: run vs. read is unambiguous

- If the skill bundles scripts, it must be clear whether the agent should _execute_ them (deterministic tool) or _read_ them (reference). Ambiguity here wastes turns.
- Prefer code for deterministic work (sorting, parsing) over asking the model to do it token-by-token.

## 5. Frontmatter correctness (silent-failure traps)

- `name` matches the folder name.
- YAML is valid: quote descriptions containing colons; spaces not tabs.
- `description` present and meaningful. These fail silently with no error, so verify explicitly.

## 6. Authoring hygiene

- Evidence the skill was shaped by real evaluation (captures actual successful approaches + common mistakes), not guessed upfront.
- Written from the model's perspective: does the body tell the agent exactly what to do next, or does it assume context?

## 7. Security (for third-party skills)

- Read bundled scripts/resources before trusting. Flag instructions that fetch from untrusted network sources or exfiltrate data. Install only from trusted sources. Skills + open network access is high-risk — require allowlists and treat tool output as untrusted.

## Modern additions (2025-2026)

- **Crisp skill / tool / prompt boundary.** System prompt = always-on global behavior; tool = acts on the world / fetches live state; skill = on-demand reusable _procedure_ (+ code + assets). Flag procedures restated in the system prompt that belong in a skill — duplicating them defeats reuse, versioning, and on-demand loading.
- **Negative routing examples.** Add explicit "Use when… / Don't use when…" plus a couple of _should-not-trigger_ examples in `SKILL.md` — measurably improves routing accuracy.
- **Design scripts like tiny CLIs.** Bundled scripts should run from the command line, print deterministic stdout, fail loudly with usage/errors, and write to known output paths.
- **Version pinning for reproducibility.** Production skills should pin skill (and ideally model) versions rather than floating on `latest`.
- **Portability (open standard).** `SKILL.md` is now a cross-platform open standard (agentskills.io, 2025-12), supported by VS Code/Copilot, Cursor, Codex, Gemini CLI, and others — keep `name`/`description` and structure portable, not tied to one client.

**Sources:** Anthropic — _Equipping agents for the real world with Agent Skills_ (2025-10: progressive disclosure, name/description as trigger, split-for-scale, run-vs-read, evaluation-first, security). OpenAI — _Skills in OpenAI API_ (2026-02: skill/tool/prompt boundary, negative routing examples, tiny-CLI design, version pinning, network-access risk). _Agent Skills_ open standard (agentskills.io, 2025-12). Frontmatter silent-failure notes align with VS Code's agent-customization guidance.
