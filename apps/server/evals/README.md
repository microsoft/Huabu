# Agent eval harness

Offline regression suite for the Sediment agent. Each case ships a
minimal Home fixture plus a user prompt and a list of assertions
on the resulting agent trace. Cases run **without** booting Fastify or
the web UI — the runner imports `runAgent` directly and replays its
events into a structured JSON `Trace`.

## Why

Iterating on `prompt/skills/**` and `modules/agent/tools/**` only
matters if you can _measure_ whether the agent got better or worse.
Without a harness every change reduces to "feels okay in the UI", and
every regression is invisible until a user trips over it.

## Quickstart

```powershell
# Run every case once, write report + per-seed traces under runs/<ts>/
pnpm --filter @huabu/server eval

# Run a single case
pnpm --filter @huabu/server eval -- --case read-node-content

# Save the current run as a named baseline (for later diffing)
pnpm --filter @huabu/server eval:baseline main

# After modifying a skill or tool, diff the new run against that baseline
pnpm --filter @huabu/server eval:diff main

# List discovered cases + saved baselines
pnpm --filter @huabu/server eval:list
```

The runner uses your active `getLLMModel()` config (Azure OpenAI / etc.
exactly as the real server does), so it costs the same per call as a
live conversation. Set `seeds` per case to control how many runs are
sampled — higher = more stable diffs, more expensive.

## Layout

```
evals/
├── cases/                    # YAML case definitions (git-tracked)
│   └── read-node-content.yml
├── fixtures/                 # Per-case minimal vaults (git-tracked)
│   └── read-node-content/
│       └── default-canvas/
│           ├── space.json
│           └── nodes/Dolphin Migration.md
├── runs/                     # Per-run output (git-ignored)
│   └── 20260511-143022/
│       ├── report.json
│       └── read-node-content-seed0.trace.json
├── baselines/                # Named saved runs (git-ignored)
│   └── main/
│       ├── report.json
│       └── *.trace.json
├── case-loader.ts            # YAML → zod-validated CaseDefinition
├── fixture.ts                # cpSync into tmp + setWorkspacePath
├── trace.ts                  # runAgent → Trace folder
├── assertions.ts             # Assertion dispatch table
├── runner.ts                 # Per-case loop: prepare → record → assert
├── differ.ts                 # Two RunReport → Markdown diff
├── cli.ts                    # run / baseline / diff / list
└── README.md
```

## Adding a case

1. **Build the fixture.** Create `fixtures/<id>/<canvasDir>/`. Inside:
   - `space.json` — at minimum `{ canvasId, title, version, state: { nodes, edges }, createdAt, updatedAt }`. The `canvasId` here MUST match the case YAML's `canvasId` (default: `default-canvas`).
   - `nodes/<safe(label)>.md` — one file per node, frontmatter must include `id` (matching the node's id in `space.json`), `type`, and `label`. Body is the markdown the agent will read.
     The directory name under `fixtures/<id>/` is arbitrary — `space.json`'s `canvasId` is what the storage layer uses to address the canvas.
2. **Write `cases/<id>.yml`** following the `read-node-content.yml` example. Validation is enforced by `case-loader.ts`'s zod schema, so typos surface as "Invalid case file" with a per-field message.
3. **Run it.** `pnpm --filter @huabu/server eval -- --case <id>`.

## Assertion catalogue

| `kind`              | Purpose                                                                          | Fields                                              |
| ------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| `tool_called`       | Agent invoked the named tool, optionally with a matching `path` arg.             | `name`, `pathEquals?`, `pathContains?`, `minTimes?` |
| `tool_succeeded`    | At least one call to the named tool returned `ok: true` (no `isError`).          | `name`                                              |
| `response_contains` | Final assistant text contains any of the provided substrings (case-insensitive). | `anyOf: string[]`                                   |
| `max_turns`         | Agent finished within the given turn budget.                                     | `max`                                               |
| `no_error`          | Run produced a `done` event (not `error`).                                       | —                                                   |
| `command_emitted`   | Some `space_commands` call carried a canvas command of this type.                | `type`, `where?`, `hasNonEmpty?`                    |

`command_emitted` exists because `tool_called: space_commands` proves almost nothing: every mutation goes through that one tool, so the decision worth asserting lives in its arguments. `where` pins literal fields on the matched command (`{ mode: grid }`), and `hasNonEmpty` requires a field to be present and non-empty — the difference between reaching for the right command and reaching for it with the payload that makes it do anything.

Add a new kind by appending to the `discriminatedUnion` in
`case-loader.ts` and the `switch` in `assertions.ts`. They are the
only two files that need to change.

## Trace shape

Every seed produces a `<caseId>-seed<N>.trace.json`:

```jsonc
{
  "schemaVersion": 1,
  "caseId": "read-node-content",
  "seed": 0,
  "startedAt": "2026-05-11T14:30:22.123Z",
  "elapsedMs": 4523,
  "turns": 2,
  "toolCalls": [
    {
      "name": "read",
      "args": { "path": "nodes/Dolphin Migration.md" },
      "ms": 7,
      "ok": true,
      "resultPreview": "...",
    },
  ],
  "finalText": "The females travel an average of 3047 km per year.",
  "error": null,
  "stopReason": "stop",
  "usage": { "input": 1234, "output": 56, "total": 1290 },
}
```

Traces are line-diffable JSON. To eyeball what an agent did on a given
seed, just open the file in VS Code.

## Diffing

```powershell
# 1. On main, capture a baseline
git checkout main
pnpm --filter @huabu/server eval:baseline main

# 2. Switch to your branch, change some skill / tool / prompt
git checkout my-skill-tweak
# … edit prompt/skills/space/SKILL.md …

# 3. Diff
pnpm --filter @huabu/server eval:diff main
```

The diff is a Markdown table of per-case deltas (`turns Δ`, `tools Δ`,
`tokens Δ`, regression / fix counts). Regressions get a detail block
listing each seed's tool sequence so you can see _what_ the agent did
differently. The full markdown is also written to
`runs/<ts>/diff.md` for sharing.

## Caveats

- Cases run sequentially because `setWorkspacePath` is process-global.
- Token / cost numbers come from `pi-ai`'s `Usage`; some providers
  under-report streaming usage. Treat the deltas as directional, not
  precise.
- LLM nondeterminism is real even at temperature 0. A case that fails
  every other seed needs to be retuned (loosen `anyOf`, raise
  `seeds`), not given more retries.
