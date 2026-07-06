# Rubric: Agent & System Prompts

Score each item `Pass / Warn / Fail`. Ordered by impact on reliable, non-wasteful behavior. Skip the shared-foundation principles (already scored in SKILL.md).

## 1. Right altitude (the Goldilocks check)

- **Fail low:** brittle if-else scripts hardcoding exact behavior for every case → fragile, high-maintenance.
- **Fail high:** vague guidance that assumes shared context and gives no concrete signal for the desired output.
- **Pass:** specific enough to steer, flexible enough to give the model strong heuristics.

## 2. Sectioned structure

- Organize into distinct, labeled sections, e.g. `<background_information>`, `<instructions>`, `## Tool guidance`, `## Output description`, using XML tags or Markdown headers.
- A wall of undifferentiated prose is **Warn** at best; the model has to hunt for the contract.

## 3. Minimal but sufficient

- Strive for the minimal set of tokens that fully outlines expected behavior — but `minimal ≠ short`. Missing the actual contract to save space is **Fail**.
- Flag restated rules, overlapping instructions, and dead caveats (token cost + context rot).

## 4. Examples: canonical, not exhaustive

- Prefer a few diverse, canonical few-shot examples that portray the expected behavior.
- **Fail pattern:** a laundry list of edge cases stuffed in to cover every rule. Examples are "pictures worth a thousand words," not an enumerated ruleset.

## 5. Tool guidance that prevents guessing

- The prompt must make clear _when_ to use _which_ tool, matching the tool descriptions. Ambiguous or missing guidance → the agent probes with trial-and-error tool calls (wasted turns).
- Flag any tool the prompt references but doesn't scope, and any bloated tool set with ambiguous decision points.

## 6. No contradictory instructions

- Two rules that can't both hold, or guidance that conflicts with a tool description, forces the model to guess which wins. **Fail.**

## 7. Transparency & planning

- For multi-step/agentic prompts: instruct the agent to surface its plan/reasoning before acting (triggers chain-of-thought, aids debuggability).

## 8. Control the loop

- For autonomous loops: specify stopping conditions (max iterations, when to hand back to the human) and persistence expectations (keep going vs. ask). Missing these causes either premature stops or runaway loops.

## Cross-check

- Output-format section must be concrete enough that the agent doesn't invent a shape (a common cause of re-tries).
- Any behavior the prompt promises must be backed by an actual tool or capability.

## Modern additions (2025-2026)

- **Concrete section template** (Codex 2026): General · Autonomy & Persistence · Code Implementation · Editing constraints · Exploration & reading · Plan/TODO · Presenting work. Use it as a checklist for missing sections.
- **Bias to action / persistence.** For agentic prompts, require end-to-end completion: don't stop at analysis or partial fixes; don't end the turn with clarifications unless truly blocked. Missing this → premature stops.
- **Match the prompt to the target model.** Preamble / upfront-plan instructions that help one model can cause _early stopping_ on another. Flag copied-over instructions that don't match the deployed model — a top cause of degradation.
- **Batch parallel reads** (directly fixes redundant tool calls). Instruct: plan all needed reads → issue one parallel batch → analyze → only then iterate. Flag any prompt that lets the agent read files one-by-one.
- **Semantic tool naming in guidance.** Steer toward unambiguous tool names (`semantic_search`, not `search`) and say when/why/how to use each, with good and bad examples.
- **Metaprompting hook.** Good prompts are iterated by asking the model to review its own instructions for what slowed it down or caused errors, then generalizing the fix.

**Sources:** Anthropic — _Effective context engineering for AI agents_ (2025-09: altitude, sectioning, minimal-not-short, canonical examples, tool-set bloat); _Building effective agents_ (2024-12: simplicity, transparency, ACI, stopping conditions). OpenAI — _Codex Prompting Guide_ (2026-02: section template, persistence/bias-to-action, model-matched preambles, parallel batching, metaprompting).
