# Rubric: Tool Descriptions & Specs

Score each item `Pass / Warn / Fail`. Items are ordered by how strongly they affect wrong or redundant tool calls. Skip the shared-foundation principles (already scored in SKILL.md).

## 1. Distinct, non-overlapping purpose

- Each tool has one clear job. If a human engineer can't definitively say which tool to use in a given situation, the agent can't either → **Fail**.
- Overlapping or vaguely-scoped tools distract the agent and cause wrong-tool calls.
- **Good:** `search_contacts`, `message_contact`. **Bad:** `list_contacts` + `get_contact` + `contact_util` with fuzzy boundaries.

## 2. Consolidate chained operations

- Prefer one tool that does the natural unit of work over several low-level tools the agent must chain.
- **Good:** `schedule_event` (finds availability + books). **Bad:** `list_users` + `list_events` + `create_event` that the agent must orchestrate every time.
- Redundant chained calls in a transcript are the signal this is missing.

## 3. Unambiguous parameter names & types

- Name parameters so the model can't misread them: `user_id` not `user`; `absolute_path` not `path` if relative paths break.
- Enforce with a strict schema (enums, required/optional). Poka-yoke the arguments so mistakes are structurally hard (e.g. require absolute paths).
- **Bad:** a free-form `query` param that the model pads with junk (Anthropic's web-search tool once had Claude appending `2025` to queries until the description was fixed).

## 4. Description reads like a docstring for a new hire

- Make implicit context explicit: special query formats, niche terminology, relationships between resources.
- Include: example usage, edge cases, input-format requirements, and explicit boundaries vs. other tools.
- Test: "Would a competent new teammate know exactly how to call this from the description alone?" If they'd have to guess, so will the model.

## 5. Namespacing

- Group related tools under a common prefix to mark boundaries: `asana_search`, `asana_projects_search`, `jira_search`.
- Especially important once the agent has many tools; reduces wrong-tool selection.

## 6. Return high-signal context

- Return fields that inform the next action (`name`, `file_type`, `image_url`); drop low-level identifiers (`uuid`, `mime_type`, `256px_image_url`) unless needed to trigger downstream calls.
- Resolve cryptic IDs to natural-language / 0-indexed handles where possible — it measurably reduces hallucination in retrieval.
- Consider a `response_format` enum (`concise` / `detailed`) so the agent controls verbosity.

## 7. Token-efficient responses

- For anything that can return a lot: provide pagination, filtering, range selection, or truncation with sensible defaults.
- On truncation, steer the agent (e.g. "make narrower searches") rather than dumping.

## 8. Actionable errors

- Validation/errors must state the specific, correctable problem and show a correctly-formatted example — not an opaque code or traceback.
- **Good:** "start_date must be ISO-8601, e.g. 2025-03-01; you sent '03/01/25'." **Bad:** `Error 422`.

## 9. Multiplexer tools: per-variant detail lives on the variant, not the shared blurb

- Applies to a tool that dispatches on a `type` discriminator (or carries many mutually-exclusive optional fields). Keep the top-level description to cross-cutting invariants only — ordering, the `results[]` contract, batching. Push each variant's own semantics, pre/post-conditions, and its one gotcha onto that variant's schema `description`.
- A caveat that governs one field belongs on that field, where the model reads it while constructing that exact call — not in the shared blurb it skimmed once on entry.
- **Bad:** the tool blurb explains an image-only aspect-ratio rule that only `CREATE_NODES.size` triggers. **Good:** that rule sits on the `size` field's `description`.
- Boundary vs #4: #4 asks whether the info is present and clear anywhere; this asks whether it is attached to the schema node that governs it.

## 10. Multiplexer tools: annotate every variant to equal depth

- In a discriminated union, one richly-described variant next to bare siblings tells the model the bare ones are simpler or gotcha-free — a false signal that drives wrong calls on the undocumented ones.
- Document every variant to comparable depth (at minimum a one-line "what it does + its lone constraint"), or defer them all to a reference — but do not mix rich-inline with bare-inline.
- The signal this is missing: one variant carries a paragraph while its peers carry only their `type` literal.

## Cross-check

- Tool descriptions must not contradict the system prompt's tool guidance.
- The response format (XML/JSON/Markdown) should match how the consuming agent is prompted to parse it.

## Modern additions (2025-2026)

- **Tool use examples beat schema alone.** For tools with nested objects, many optional params, or domain conventions, ship 1-5 concrete example calls (`input_examples`) using realistic data, spanning minimal / partial / full specification. Schema says what is _valid_; examples say what is _correct_. Measured 72% → 90% on complex parameter handling.
- **Discoverability for tool search.** In large libraries, defer-load most tools and keep only the 3-5 highest-use ones resident. Search matches on name + description, so vague names (`query_db_orders`, "Execute order query") fail discovery; descriptive ones (`search_customer_orders` + what it returns) win. Similar names (`notification-send-user` vs `notification-send-channel`) are a top error source — make them distinguishable.
- **Document return formats.** If a tool may be orchestrated from code (programmatic tool calling), spell out the return shape (fields + types) in the description so parsing logic is correct.
- **Programmatic-friendly shape.** Idempotent, parallelizable tools that only need aggregates are best consumed via code orchestration (3+ dependent calls or large datasets) — flag tools whose results are large but only summarized.

**Sources:** Anthropic — _Writing effective tools for agents_ (2025-09); _Building effective agents_, Appendix 2 (docstring-for-junior-dev, poka-yoke, absolute-path); _Introducing advanced tool use_ (2025-11: tool search / `defer_loading`, `input_examples`, programmatic tool calling). OpenAI — _Codex Prompting Guide_ (2026-02: semantic tool naming, response truncation).
