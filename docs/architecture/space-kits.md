# Space Kits

Space Kits are source-distributed, Agent-executed installation Skills. A user creates an Agent in an existing blank Space, supplies a trusted GitHub repository/revision and Kit path, and asks it to clone and follow `SKILL.md`. Installed content initializes that one Space, not a Workspace, a Profile installation or a new Huabu service.

```text
user supplies repository + Kit path
  -> Agent clones a chosen revision and reads SKILL.md (issue-tracker-setup)
  -> Step 1: read-only RFS preflight + lay out native Frames/Notes/Configuration with final instruction titles
  -> Step 2: user fills in & confirms the Markdown configuration table on the Space
  -> Step 3: rerun installer to validate configuration, turn configuration Frame green, and create & wire idle Coordinator
```

## Distribution and content

The first Kit lives in [`space-kits/issue-tracker-setup/`](../../space-kits/issue-tracker-setup/), matching the `issue-tracker-setup` installation Skill name. Huabu does not discover, serve, package or execute Kits itself. This adds no API, Skill resolver, Service package, Team runtime, Task/Run/View, canvas ledger Note, or desktop resource pipeline. The installer uses an existing Node 24.16+ runtime with no dependencies, resolves package inputs relative to its own file (not cwd or a Server-local checkout), and invokes the `huabu-rfs` CLI (`HUABU_RFS_ENTRY`) when present while falling back to native HTTP (`HUABU_RFS_URL` + `AGENTLET_TOKEN`). It automatically resolves the installer Agent's Node ID from `HUABU_THREAD_ID` when available.

`SKILL.md` owns installation procedure; assets own installed bytes. Record the cloned commit in conversation history for provenance; there is no `kit.json`, canvas Installation Record, signed publication, or upgrade loader. The old Issue Tracker Team Skill, prompt and safety preamble moved into the Kit and were rewritten from the current Space workflow; obsolete manifest/renderer were removed. Other retained Team packages are unchanged.

Static content includes Coordinator role, common instructions, lazy fixing safety contract, single-Agent-node issue layout, and root-level onboarding Text (`assets/setup-instructions.txt`). Editable configuration is a single Markdown table Note (`assets/configuration.md`) inside `prompt: issue tracking configuration`: it requires only `codebasePath` and `fixingProfileId` upfront (plus `confirmedByUser: true`), while blank optional cells use sensible defaults/runtime derivation for `coordinatorProfileId` (defaults to `fixingProfileId`), `repository` (derived from `codebasePath` Git remotes when omitted), `worktreeRoot` (defaults to `<codebasePath>-worktrees`), `developmentBaseRef` (prefilled `"origin/main"`), and `pullRequestBase` (prefilled `"main"`). Custom delivery branches (such as `origin/alpha` / `alpha`) are configured explicitly when needed and enforced fail-closed without silent fallback. The Coordinator inherits its selected Profile's cwd, not a path copied from the Kit checkout, and downloads the live configuration Note before each new execution unit rather than relying solely on its initial Prompt snapshot.

## Installation boundaries

The helper previews by default; `--apply` authorizes its ordinary RFS writes after the Agent has obtained user installation approval. Initial layout preflight requires complete bounded node/edge inventory, excluding only the identified installer Agent; an unrelated non-empty Space blocks overlay installation.

Setup state lives in the installer Agent's conversation context (returned as a `nodes` map from Step 1 and accepted via `--nodes` in Step 3, with fallback lookup of the unique canonical instruction Frames on the Space). No machine-state ledger Note is written to the Space, so user notes, layout adjustments, or edits on the canvas after Step 1 do not trigger ownership lockouts during Step 3. Rerunning after readiness reuses the existing Coordinator and performs no writes when unchanged.

## Three-step layout, configuration, and finalization

Installation separates Space layout from Coordinator creation so the user does not have to supply Profile IDs or repository paths before seeing the configuration table on the canvas:

1. **Step 1 (Layout)**: The helper creates instruction Frames with their final recognized titles (`prompt: issue tracking common`, `prompt: issue tracking coordinator`, `skill: issue fixing`, and amber `prompt: issue tracking configuration`), places direct child Notes inside them, adds a root-level onboarding Text node outside all instruction Frames (listing selectable external Profiles and field instructions so onboarding prose never enters Space Prompts), arranges Frames using structured layout, and stops in `state: "needs_configuration"` with `coordinator: null` and the created `nodes` IDs returned to the installer Agent's conversation context.
2. **Step 2 (Configure)**: The user edits only the `Value` column of the **Issue Tracker Configuration** Markdown table Note on the Space, supplying required `codebasePath` and `fixingProfileId` (leaving optional overrides blank or setting custom values) and changing `confirmedByUser` to `true`.
3. **Step 3 (Finalize)**: Rerunning the helper with `--apply` (passing `--nodes` from Step 1 or resolving the unique setup Frames on the Space) validates the configuration table, turns `prompt: issue tracking configuration` green, creates a fresh fixed external Coordinator (`noStart` / `X-Huabu-Agent-Start: false`, without parent lineage or host-thread correlation) using the resolved Coordinator Profile (`--profile` override, or `coordinatorProfileId ?? fixingProfileId`), connects its specific Prompt Frame, and returns `state: "ready"`. Passing `--profile` overrides the Coordinator Profile selection without bypassing valid confirmed configuration.

Common and Configuration Prompts are global; Coordinator Prompt has exactly one direct Agent neighbour; the fixing Skill is lazy. Instruction Frame titles never undergo a second rename. The installer never sends prompts, warm-ups or mode/model/config controls. Prompt capture/realization behavior remains the existing [Agent Context](./agent-context.md) contract.

Amber/green Frame styling, the external onboarding Text node, and field-level REQUIRED/INVALID/UNVERIFIED diagnostics expose configuration state. `ready` requires a structurally valid user-confirmed configuration table and verified object/topology/geometry state, including the created and wired Coordinator. Color is not a technical launch interlock; the user must not interact with the Coordinator before configuration and topology are `ready`. Structural checks do not prove a remote filesystem true; the Coordinator verifies Git/path/device facts before creating an execution environment. Existing execution units retain their saved delivery identities even after configuration changes.

## Installed issue workflow

Each issue execution unit on the Space is represented by a **single Fixing Agent node** placed directly inside the `Issues` Frame (horizontal row, fixed size `400x300` rather than auto height), without a per-issue Frame or a separate Execution Note node. The installed **Issue Frame Layout** asset is the naming authority: Fixing Agent node labels use `<status emoji> <issue identity> · <stable issue title>`. Lifecycle is carried only by 🛠/🟣/⛔/🚀/✅, without status words or `Fixing Agent`/`Agent`/`Issue Frame` suffixes, and complete Agent labels are at most 80 characters. The setup Coordinator has no issue identity and retains its role label.

Coordinator dispatch is acceptance-only and asynchronous: pass all authoritative execution identities (`Issue`, `Worktree`, `Branch`, `Base ref @ SHA`, `PR Base`, `Fixing Profile`, `Agent Node ID`, `Agent Thread ID`) and the user-confirmed objective directly in the Fixing Agent's initial prompt, confirm prompt acceptance and the existing Thread, stop consuming the stream, and return control. Disconnecting delivery is not cancellation of the durable turn. The Coordinator does not buffer final-answer SSE output, wait for a final answer or poll for status. This is installed Agent guidance using existing RFS, not a new installer dispatch API. The installer itself never prompts an Agent.

Acceptance must be observable under the live transport contract; HTTP success or a Thread announcement alone is insufficient. The current RFS prompt stream does not expose the service's internal acceptance promise as a distinct acknowledgment, so dispatch confirmation must be reported as blocked if the available live contract provides no such signal. This Kit change does not add that runtime capability or claim provider-level dispatch validation.

The Fixing Agent reports investigation findings, root cause, and the minimal implementation plan directly in its own Agent chat for user confirmation (and in the PR body when a PR is prepared, or a GitHub issue comment when authorized) and updates its compact Agent node label (`🟣`, `🛠`, `⛔`, `🚀`) before ending each milestone turn. Status reconciliation occurs on user request, an available runtime notification, or before a dependent action; receiving a final response/notification is not required for durable handoff and does not prove execution completion. Only the Coordinator sets `✅` after verifying completion.

The `issue-tracker-setup` Skill uses a Markdown configuration table inside `prompt: issue tracking configuration`, places onboarding guidance in a root-level Text node outside instruction Frames, uses final `prompt:`/`skill:` Frame titles from initial creation without a second rename, keeps setup state in the installer Agent's conversation context without any canvas Installation Record or `kit.json`, and updates configuration Frame color from amber to green once validated and confirmed.

## Code entry points

| File                                                                                             | Responsibility                                                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [`SKILL.md`](../../space-kits/issue-tracker-setup/SKILL.md)                                      | Installer trigger, procedure, approval and recovery boundaries         |
| [`scripts/install.mjs`](../../space-kits/issue-tracker-setup/scripts/install.mjs)                | Package-local preview/materialization through existing RFS             |
| [`assets/`](../../space-kits/issue-tracker-setup/assets/)                                        | Portable installed contracts/Prompts and configuration schema/template |
| [`tests/`](../../space-kits/issue-tracker-setup/tests/)                                          | Content/configuration and real RFS/storage/topology acceptance         |
| [`rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts)                           | Existing unmodified RFS transport                                      |
| [`space-instruction-frames.ts`](../../apps/server/src/modules/agent/space-instruction-frames.ts) | Existing unmodified Prompt/Skill scoping and budgets                   |
