# Agent Memory

> Status: Shipped
> Last updated: 2026-08-17

Lets the agent remember, across sessions and canvases, "who the user is, what
this canvas is about, and which approaches are reusable". The whole mechanism is
non-blocking; the LLM decides what to write.

---

## 1. Three memory tiers

| Tier      | Scope        | Path                                       | User-visible | Purpose                                                              |
| --------- | ------------ | ------------------------------------------ | ------------ | -------------------------------------------------------------------- |
| Workspace | cross-canvas | `<workspace>/setting/user.md`              | ✅           | user profile, style prefs, answer length — cross-canvas preferences  |
| Canvas    | per-canvas   | `<canvas>/.memory/space.md`                | ❌ hidden    | what this canvas is doing, current intent, small confirmed decisions |
| Skill     | cross-canvas | `<workspace>/setting/skills/<id>/SKILL.md` | ✅           | reusable approaches / recipes                                        |

**Caps**: workspace + canvas memory each hard-capped at 4 KB / 80 lines; skills have no size cap but a high creation bar (§4.3).

**Skills are dual-source**: system skills ship in `apps/server/src/prompt/skills/<id>/` (read-only); user/curator skills live in `<workspace>/setting/skills/<id>/`. Same id → merged "system first + user appended"; loader in [skills/loader.ts](../../apps/server/src/prompt/skills/loader.ts).

Ordinary task Skills run on the Chat Model as part of the current Chat-backed Deployment. Only the explicit `/create-skill` and `/update-skill` authoring commands use the `skill` model role, which resolves through the Utility Model and, when Utility is not configured, defaults to the cheapest eligible model in the chat provider (ultimately the Chat Model). Authoring turns are fresh Agenetes Jobs so their role is not frozen into an existing Deployment; before the Job, the live Deployment is closed, and the next normal Chat turn rehydrates the durable authoring turn before returning to the Chat Model. The `skill` role is vision-capable: when the resolved model cannot accept required image input, model resolution falls back to the Chat Model.

---

## 2. Triggers — who writes, when

Two independent write paths:

### 2.1 Background curator (automatic)

- Each canvas keeps an op counter in `<canvas>/.memory/state.json`.
- Every _mutating_ HTTP request (PUT / POST / PATCH / DELETE for that canvas) is counted by a Fastify hook ([memory/op-counter-hook.ts](../../apps/server/src/modules/agent/memory/op-counter-hook.ts)).
  - `POST /api/canvas/<id>/events` is weighted by `events.length` (one flush of five actions = +5).
  - Every other request = +1.
  - Failed responses (4xx / 5xx) don't count.
- counter ≥ `OP_THRESHOLD = 50` → triggers one memory-analysis pass; the trigger resets to 0 immediately to avoid re-firing.
- Then a **per-canvas single-flight** worker runs ([memory/worker.ts](../../apps/server/src/modules/agent/memory/worker.ts)): an already-running pass just sets a pending flag, no queue.
- `setImmediate` dispatch — the route responds to the client first; the curator starts on the next tick.
- Failures only `warn`, never throw; the next trigger naturally retries.
- If the Space record no longer exists, the pass is skipped before reading memory files or calling the model, and `markAnalyzed` is not advanced.
- The curator uses [agents/memory/AGENT.md](../../apps/server/src/prompt/agents/memory/AGENT.md), max 5 iterations, sequential tool calls.
- The curator runs with the `memory` model role, which resolves through the Utility Model and, when Utility is not configured, defaults to the cheapest eligible model in the chat provider (ultimately the Chat Model).

### 2.2 Explicit requests in chat

Normal ask / operate turns do not write memory directly. Ask is read-only, and operate reserves `fs_write` for an explicitly invoked `/create-skill` or `/update-skill`. The background curator no longer scans chat files; its evidence is the current Space snapshot, recent action events, and existing memory. A plain-language "remember this" request therefore becomes a curation candidate only when it is also reflected in those Space-owned sources.

User Skill creation and updates are explicit slash-command flows on the built-in operate surface. `/create-skill` checks the catalogue for near matches but does not silently switch to an update; `/update-skill` resolves and reads an existing user or merged Skill before writing it.

---

## 3. Reading — who reads how

There is one read path: the `read()` tool, three entries.

| Tool call                                          | Resolves to                     |
| -------------------------------------------------- | ------------------------------- |
| `read("memory/user.md")`                           | `<workspace>/setting/user.md`   |
| `read("memory/space.md")` (needs canvasId context) | `<canvas>/.memory/space.md`     |
| `read("skills/<id>/SKILL.md")`                     | merged system + user skill body |

Implemented in [tools/handlers/fs-read.ts](../../apps/server/src/modules/agent/tools/handlers/fs-read.ts); an unknown `memory/*.md` path errors back to the agent.

**Injection strategy**:

- **Every turn**: the route appends `user.md` as a `<workspace_memory>` tag block at the end of the built-in agent's system prompt (so cross-canvas prefs apply stably each turn, and it stays prompt-cache-friendly). See where [agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts) assembles `systemPrompt`. Built-in pi-agent path only; external/ACP has its own preamble and doesn't read workspace memory.
- **Skill / memory entries**: listed in the "Available skills / memory" section of the system prompt; the agent decides whether to `read()`.

Canvas memory is **always pull-only** — it's large and situational, so the agent decides whether to fetch it.

---

## 4. Writing — the single `fs_write` entry

All three tiers share one tool: `fs_write({ path, mode, ... })`. The agent picks a target via the virtual `path` and a method via `mode`. Failures always return a structured `WriteResult` (`{ ok, target, reason }`), never throw.

| `path`                 | File                                       | Note                                            |
| ---------------------- | ------------------------------------------ | ----------------------------------------------- |
| `memory/user.md`       | `<workspace>/setting/user.md`              | cross-canvas user profile, pure bullet markdown |
| `memory/space.md`      | `<canvas>/.memory/space.md`                | per-canvas situational brief                    |
| `skills/<id>/SKILL.md` | `<workspace>/setting/skills/<id>/SKILL.md` | user skill; creation needs a `rationale`        |

Both modes work on every path:

- `mode: "overwrite"` — replace the whole file with `body`; creates it if missing.
- `mode: "replace_string"` — find the unique `oldString` and replace with `newString`. File must exist; 0 or ≥2 matches are rejected.

Implementation: routing + validation in [tools/handlers/fs-write.ts](../../apps/server/src/modules/agent/tools/handlers/fs-write.ts), disk primitives in [memory/writers.ts](../../apps/server/src/modules/agent/memory/writers.ts), path sandbox in [memory/sandbox.ts](../../apps/server/src/modules/agent/memory/sandbox.ts).

### 4.1 Shared constraints

- Workspace + canvas memory are both capped at **4 KB / 80 lines** (both overwrite and replace_string validate the merged size). Skill files are uncapped.
- The cap is enforced on writes through `fs_write`; an oversized hand-edited file is not automatically trimmed. A later write whose resulting body remains oversized is rejected.
- Sandbox dual root: workspace root is `<workspace>/setting/`, canvas root is `<canvas>/.memory/`. `..` escapes are rejected.
- `replace_string`'s "exactly once" rule is a safety contract: ambiguity is resolved by the agent supplying more context, never guessed by the writer.

### 4.2 Workspace-memory discipline

There's no writer-level "append-only" guard anymore — overwrite can replace the whole file. It's held by prompt discipline (`prompt/skills/memory/write/user-memory-writing.md`): "default to `replace_string`; never delete a user's hand-edited bullet via `overwrite`". The agent must `read("memory/user.md")` first, know the current content, then decide what to change.

### 4.3 Skill-write bar

- **Creating a new skill** (target missing + `mode: "overwrite"`):
  - must supply a `rationale` ≥ 20 chars (why an existing skill can't be updated instead). The handler enforces this when `existsSync(absPath) === false`.
  - `body` must include a full frontmatter fence (the writer no longer renders it).
  - **`appliesTo` must include the caller's own surface** (a skill written by operate must include `'operate'`), else next turn it won't see it in its own catalogue = self-ban. Held by prompt discipline; the loader doesn't validate it.
- **Editing an existing skill**: `mode: "replace_string"` (preferred) or `mode: "overwrite"` (for structural rewrites). Both require the agent to `read("skills/<id>/SKILL.md")` first: replace_string needs a unique `oldString`, overwrite needs the full old body.
- On success it immediately calls `invalidateUserSkill(id)` so the next `read("skills/<id>/SKILL.md")` gets fresh content without waiting for the 2s TTL.

### 4.4 Write policy (for the agent)

The tool description carries only mechanics (params / cap / validation); **policy lives in the write sub-docs** (pulled explicitly via `read()`, not in the catalogue):

- [write/user-memory-writing.md](../../apps/server/src/prompt/skills/memory/write/user-memory-writing.md)
- [write/space-memory-writing.md](../../apps/server/src/prompt/skills/memory/write/space-memory-writing.md)
- [write/skills-writing.md](../../apps/server/src/prompt/skills/memory/write/skills-writing.md)

The curator AGENT.md points at all three sub-docs. The operate Agent receives Skill-writing policy only when `/create-skill` or `/update-skill` injects the corresponding user-invokable Skill; normal ask / operate turns do not write memory.

---

## 5. Code entry points

| Concern                                                 | File                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-turn workspace-memory injection (system-prompt tag) | [agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts)                                                                                                                                                                                                                                    |
| Public entry `enqueue(canvasId)`                        | [memory/index.ts](../../apps/server/src/modules/agent/memory/index.ts)                                                                                                                                                                                                                                  |
| op counter + state.json                                 | [memory/trigger.ts](../../apps/server/src/modules/agent/memory/trigger.ts)                                                                                                                                                                                                                              |
| Global Fastify hook                                     | [memory/op-counter-hook.ts](../../apps/server/src/modules/agent/memory/op-counter-hook.ts)                                                                                                                                                                                                              |
| Per-canvas single-flight                                | [memory/worker.ts](../../apps/server/src/modules/agent/memory/worker.ts)                                                                                                                                                                                                                                |
| context → runAgent → WriteResult                        | [memory/analyzer.ts](../../apps/server/src/modules/agent/memory/analyzer.ts)                                                                                                                                                                                                                            |
| overwrite + replace_string primitives                   | [memory/writers.ts](../../apps/server/src/modules/agent/memory/writers.ts)                                                                                                                                                                                                                              |
| Dual-root path check                                    | [memory/sandbox.ts](../../apps/server/src/modules/agent/memory/sandbox.ts)                                                                                                                                                                                                                              |
| Read entry                                              | [memory/read.ts](../../apps/server/src/modules/agent/memory/read.ts)                                                                                                                                                                                                                                    |
| Path helpers                                            | [workspace/paths.ts](../../apps/server/src/modules/workspace/paths.ts)                                                                                                                                                                                                                                  |
| `fs_write` tool def                                     | [tools/definitions.ts](../../apps/server/src/modules/agent/tools/definitions.ts)                                                                                                                                                                                                                        |
| fs_write handler                                        | [tools/handlers/fs-write.ts](../../apps/server/src/modules/agent/tools/handlers/fs-write.ts)                                                                                                                                                                                                            |
| fs_read handler                                         | [tools/handlers/fs-read.ts](../../apps/server/src/modules/agent/tools/handlers/fs-read.ts)                                                                                                                                                                                                              |
| Curator system prompt                                   | [agents/memory/AGENT.md](../../apps/server/src/prompt/agents/memory/AGENT.md)                                                                                                                                                                                                                           |
| Chat agents                                             | [ask/AGENT.md](../../apps/server/src/prompt/agents/ask/AGENT.md) · [operate/AGENT.md](../../apps/server/src/prompt/agents/operate/AGENT.md)                                                                                                                                                             |
| Skill loader (dual-source + mtime cache)                | [skills/loader.ts](../../apps/server/src/prompt/skills/loader.ts)                                                                                                                                                                                                                                       |
| Write-policy sub-docs                                   | [write/user-memory-writing.md](../../apps/server/src/prompt/skills/memory/write/user-memory-writing.md) · [space-memory-writing.md](../../apps/server/src/prompt/skills/memory/write/space-memory-writing.md) · [skills-writing.md](../../apps/server/src/prompt/skills/memory/write/skills-writing.md) |

---

## 6. Relationship to existing systems

- The curator reads Space existence and the bounded action-event tail through the structured repository. Memory body/state files remain materialized workspace capabilities. Chat history is owned by Agenetes and is not part of the curator bundle.
- `<canvas>/.memory/` is in `ALWAYS_SKIP` ([fs-sandbox.ts](../../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts)) — invisible to grep / find / ls; reachable only through the controlled `read("memory/space.md")` path.
- The skill loader uses mtime + 2s TTL + `invalidateUserSkill(id)` for write-then-read freshness. System skills are cached once-and-done.

---

## 7. Safety / consistency boundaries

- Every write path goes through `MemorySandboxError` validation.
- Within a single Node process, per-canvas single-flight keeps the curator from concurrently writing the same canvas; workspace memory is serialised across canvases by an in-module `workspaceMemoryLock`. Multi-process deployment needs separate design; single-process is assumed today.
- `markAnalyzed` records only the completion timestamp. The legacy `lastSeenThreadCursor` key is preserved when old `state.json` files are rewritten, but current passes do not advance or consume it.
- A failed write (rationale too short, cap exceeded, non-unique `oldString`, …) → `WriteResult.ok=false`; the worker logs it into the summary and the next trigger retries.
