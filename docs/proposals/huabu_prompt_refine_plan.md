# Huabu Agent & Canvas — Issue Catalogue

Status: Living document (append-only registry)

> A running registry of problems on **how the Huabu agent is prompted and how
> its tool calls behave** — operate & reachback system prompts, the canvas skill
> / tool descriptions, and the downstream effects of agent tool calls (e.g.
> `canvas_commands` → preprocessing). Out of scope: pure UI and non-agent server
> issues. It started from one reachback trace but is meant to grow: **append new
> issues at the bottom with the next ID.** Each entry is self-contained; shared
> logs live once under [Reference traces](#reference-traces) and are cited by ID.

## How to add an issue

1. Take the next free ID (letters `A…Z`, then `AA…`), add a row to the [Index](#index).
2. Copy the template below into [Issues](#issues), ordered by ID.
3. If it cites a log/trace, add it once under [Reference traces](#reference-traces) and link by ID.

<details><summary>Issue entry template</summary>

```md
<a id="X"></a>

### X — <short title>

- **Area:** preprocessing | operate-prompt | canvas-commands | reachback | …
- **Severity:** perf | correctness | UX
- **Status:** Open | In progress | Done (<date>) | Won't fix
- **Trace:** TR# (optional)

**Symptom.** What goes wrong and where (link the code).

**Direction / Fix.** Intended change; note trade-offs.

**Notes / follow-ups.** Anything deferred.
```

</details>

## Index

| ID      | Title                                                     | Area            | Severity           | Status            |
| ------- | --------------------------------------------------------- | --------------- | ------------------ | ----------------- |
| [A](#A) | Canvas skill read on demand costs 2 extra LLM turns       | operate-prompt  | perf               | Open              |
| [B](#B) | LLM enrich re-runs when its source didn't change          | preprocessing   | perf + correctness | Done (2026-07-03) |
| [C](#C) | Read-only recon spread across turns instead of batched    | operate-prompt  | perf               | Open              |
| [D](#D) | Agent invents node IDs to self-reference within one batch | canvas-commands | correctness        | Open              |

---

## Reference traces

<a id="TR1"></a>

### TR1 — reachback `req-3d` (184s total)

External `deepv` agent uploaded 4 files, then asked the built-in `operate` agent
(via RFS `POST /api/rfs/:canvasId/agent`) to create 4 nodes (2 images, 1 note,
1 pptx) and link them back to a source note.

| Time (UTC) | Turn | Tool calls                                                       | Gap                  |
| ---------- | ---- | ---------------------------------------------------------------- | -------------------- |
| 07:03:19   | —    | prompt received                                                  |                      |
| 07:03:30   | T1   | `inspect_nodes(source)`                                          | 11s (first LLM turn) |
| 07:03:36   | T2   | `ls(upload)` + `inspect_nodes(nearNode)`                         |                      |
| 07:04:05   | T3   | `read(upload/…outline.md)` + **`read(skills/canvas/SKILL.md)`**  | 30s                  |
| 07:04:13   | T4   | **`read(skills/canvas/references/commands.md)`** + `grep(^src:)` |                      |
| 07:06:09   | T5   | `canvas_commands` (CREATE ×4 + CONNECT)                          | ~116s                |
| 07:06:11   | —    | server applied commands                                          | 1.6s server-side     |
| 07:06:24   | —    | `done` (final summary)                                           | 13s                  |

Takeaway: server work is cheap; the cost is the **number of sequential LLM
turns**. (Cited by A–D; the ~7.5s/image preprocess in this run motivated B.)

---

## Issues

<a id="A"></a>

### A — Canvas skill read on demand costs 2 extra LLM turns

- **Area:** operate-prompt
- **Severity:** perf
- **Status:** Open
- **Trace:** [TR1](#TR1) (turns T3–T4)

**Symptom.** Both
[`operate/AGENT.md`](../../apps/server/src/prompt/agents/operate/AGENT.md) and
the `canvas_commands` tool description in
[`tools/definitions.ts`](../../apps/server/src/modules/agent/tools/definitions.ts)
tell the agent to `read("skills/canvas/SKILL.md")` on demand, which links out to
`references/commands.md`. Almost every run ends in a mutation, so almost every
run first spends two whole turns reading static reference docs — `read(SKILL.md)`
then `read(commands.md)` — before it can issue its first `canvas_commands`. These
docs never change between runs, yet they are re-read every time.

**Direction / Fix.** Inline a condensed command cheat-sheet (command names +
required fields + the batch-ordering / explicit-id rule) into the operate system
prompt so the common case needs no `read` at all; keep the full `SKILL.md` /
`references/` as the deep-dive the agent only opens for non-trivial layouts.

**Notes / follow-ups.** Risk: system-prompt bloat and drift between the inlined
cheat-sheet and the canonical `SKILL.md`. Needs a single source of truth
(generate the cheat-sheet from the skill, or keep it minimal and link out).

<a id="B"></a>

### B — LLM enrich re-runs when its source didn't change

- **Area:** preprocessing
- **Severity:** perf + correctness
- **Status:** Done (2026-07-03)
- **Trace:** [TR1](#TR1) (the ~7.5s/image preprocess)

**Symptom.** An LLM Enrich capability (`generate_label` / `generate_summary` /
`generate_keywords`) re-runs even when the input it derives from didn't change.
Current gaps by type:

| Node       | Enrich (LLM) caps          | Wastes an LLM call on a src-unchanged edit?                                                                      |
| ---------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| web / pdf  | label + summary + keywords | Mostly no — `cache-check.ts` (Stage 1.5) short-circuits Stages 2-5 when `src` is unchanged and content is cached |
| **office** | label + summary + keywords | **Yes** — no cache short-circuit, so a rename re-extracts + re-enriches                                          |
| **image**  | label (vision)             | **Yes** — no cache short-circuit; the ~7.5s/image cost in the trace, and label edits also trigger it             |
| video      | none                       | No — no Enrich capability exists                                                                                 |

Real gaps: **image** and **office**; web/pdf are covered by `cache-check` (a
heavier short-circuit that also skips re-extract), and video has no LLM stage.

**Direction / Fix (implemented — declarative, level 2).**

- `profiles.ts` gains a declarative `capabilityTriggers` map per node type
  (`generate_label/summary/keywords → ['src']`, frame → `['childLabels']`,
  question → `['content']`). Policy lives as data next to `watchFields`.
- `dispatcher.buildPlan` is now a generic engine: it keeps a trigger-gated
  capability only when one of its trigger fields is dirty (on first run every
  watched field counts as dirty), and drops `generate_label` whenever the label
  is protected.
- A single shared `isLabelProtected(labelSource, label)` helper
  (`preprocessing/label-policy.ts`) is used by both `buildPlan` (skip upstream)
  and `project.ts` (discard downstream) — one source of truth.
- `cache-check` stays as-is (complementary web/pdf re-extract short-circuit).
- Covered by `dispatcher.test.ts` (10 cases).

**Notes / follow-ups.** Separate, larger: give `office` its own cache
short-circuit so a rename skips re-extraction too, matching pdf.

<a id="C"></a>

### C — Read-only recon spread across turns instead of batched

- **Area:** operate-prompt
- **Severity:** perf
- **Status:** Open
- **Trace:** [TR1](#TR1) (turns T1–T2)

**Symptom.** The agent gathers cheap, independent read-only context one step at
a time: `inspect_nodes(source)` in one turn, then `ls(upload)` +
`inspect_nodes(nearNode)` in the next. Each avoidable step is a full model
round-trip. `operate` already runs `toolExecution: parallel`, so these tools
_can_ run together — the prompt just doesn't push the agent to front-load recon.

**Direction / Fix.** Nudge the operate prompt to gather all read-only context
(`inspect_nodes` / `ls` / `read` of referenced files) in a single opening batch
before planning the mutation.

**Notes / follow-ups.** —

<a id="D"></a>

### D — Agent invents node IDs to self-reference within one batch

- **Area:** canvas-commands
- **Severity:** correctness
- **Status:** Open
- **Trace:** [TR1](#TR1) (the CREATE ×4 + CONNECT batch)

**Symptom.** The `canvas_commands` ID convention says "use
`crypto.randomUUID()`", but the model has no real UUID source. So when a later
command in the same atomic batch must reference a node created earlier (e.g.
`CONNECT_NODES` linking freshly `CREATE_NODES`d nodes), the agent fabricates
placeholder IDs like:

```
node-11111111-aaaa-4aaa-8aaa-111111111111
node-22222222-bbbb-4bbb-8bbb-222222222222
```

These are not random. Two runs that both fall back to the same placeholders
**collide**, breaking idempotency / CAS and possibly cross-linking nodes between
unrelated runs.

**Direction / Fix.** Instead of forcing the agent to mint IDs to self-reference
inside one atomic batch, split the operation into steps: issue `CREATE_NODES`
first, let the **server assign the real ids** and return them, then issue the
follow-up `CONNECT_NODES` / `SET_NODE_PARENT` against those server ids.

**Notes / follow-ups.** Trade-off: adds a turn (works against A/C's "fewer
turns" goal) and splits the single-undo-step guarantee. Weigh atomic-batch
semantics vs. safe ids — e.g. keep the atomic batch but have the server
rewrite/validate client-supplied ids, or return an id map the agent can reuse.
