# Agent Diagnosis Guide

Status: Living document

> How to figure out **why an agent is slow or not behaving as expected** on a
> Huabu Space, and how to turn that into fix-ready material. Covers both:
>
> - **Built-in Huabu agents** — `operate` / `ask` / memory, run
>   in-process by Huabu.
> - **External ACP agents** — agentlet-spawned harnesses (e.g. `deepv`, GitHub
>   Copilot CLI) that connect over ACP and can reach back into the canvas.
>
> Scope is how agents are prompted and how their tool calls behave (system
> prompts, the canvas skill / tool descriptions, and downstream effects like
> `space_commands` → preprocessing). Out of scope: pure UI and non-agent server
> issues.
>
> **Tracking lives in GitHub issues, not here.** This doc is only the playbook
> for diagnosing a run and packaging evidence; file the actual problems as an
> issue (see [Hand off](#hand-off)).

## Gather the evidence

Pin down what actually happened in the failing round. `<canvas>` below is the
canvas folder inside the active workspace.

**1. The recorded conversation (both agent kinds).** Every thread persists under
`<canvas>/.history/chat/`:

- `<threadId>.turns.jsonl` — one line per finalized turn: the messages and tool
  calls exactly as the agent ran them. For ACP threads the rich agent parts are
  folded into the turn record here (the old `.parts.json` sidecar is gone).
- `<threadId>.active.json` — the single in-progress turn (partial), if any.

**2. The assembled prompt — built-in agents only.**
`<canvas>/.history/chat/<threadId>.prompt.log` is a human-readable dump of the
**fully-assembled** prompt sent to a built-in agent, one block per turn (gated by
`HUABU_DEBUG_PROMPT`, default-on in development and off in production; see
[`debug-prompt.ts`](../apps/server/src/modules/agent/conversation/prompt/debug-prompt.ts)).
External ACP agents assemble their own prompt inside the external harness, so
there is **no** `.prompt.log` for them — read their `.turns.jsonl` plus the
`[acp]` lifecycle in `server.log` instead.

**3. ACP agent lifecycle — `server.log`.** For an external ACP agent, its
dispatch / spawn / permission prompts are logged in
[`apps/server/data/logs/server.log`](../apps/server/data/logs/server.log) under
`[acp]`:

- Find dispatches (which thread, which agent alias / profile, agent-team resolve):

  ```powershell
  Select-String "ACP dispatch|session/prompt dispatch|agent_team_resolved" apps\server\data\logs\server.log
  ```

- Pull one ACP round: grep its Huabu `thread-<id>` — permission prompts show
  as `session/request_permission`, each user grant as `resolved by user`.

**4. When an ACP agent drives the canvas (reachback) — `ask-huabu`.** When an
external agent calls back into the canvas via RFS, the built-in `operate` agent
it triggers is bracketed by greppable banners in the same log:

- List every round with its boundaries (canvas, prompt preview, elapsed, tool
  count, outcome):

  ```powershell
  Select-String "ask-huabu" apps\server\data\logs\server.log
  ```

- Pull one whole round: copy its `reachback-…` id from the `BEGIN` line, then
  grep it (every line carries `[reachback <threadId>]`). Each tool shows as
  `→ tool <name> <args>` (call) / `← tool <status> <result>` (result); the `END`
  line reports `ok` / `error` / `aborted`, elapsed, and tool count.

## Hand off

Turn the evidence into a GitHub issue — that's where tracking, status, and
discussion live.

- **Cause found** → open an issue with the symptom and a fix direction. One
  issue may bundle several problems found in the same conversation.
- **Cause unclear** → still open an issue and attach the raw evidence
  (`<threadId>.turns.jsonl`, `<threadId>.prompt.log`, and/or the `server.log`
  slice) so someone else can pick it up.

Example:
[hai-team/Huabu#268](https://github.com/hai-team/Huabu/issues/268) bundles
three operate/reachback problems from a single run, with the trace and fix
directions.
