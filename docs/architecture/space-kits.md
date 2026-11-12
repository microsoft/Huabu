# Space Kits

Space Kits are source-distributed, Agent-executed installation Skills. A user creates an Agent in an existing blank Space, supplies a trusted GitHub repository/revision and Kit path, and asks it to clone and follow `SKILL.md`. Installed content initializes that one Space, not a Workspace, a Profile installation or a new Huabu service.

```text
user supplies repository + Kit path
  -> Agent clones a chosen revision and reads SKILL.md
  -> Step 1: read-only RFS preflight + lay out native Frames/Notes/Configuration (no Profile/paths required upfront)
  -> Step 2: user fills in & confirms Issue Tracker Configuration (Profiles, repo, paths, refs) on the Space
  -> Step 3: rerun installer to validate configuration, create & wire idle Coordinator, and activate instruction labels
```

## Distribution and content

The first Kit lives in [`space-kits/issue-tracker/`](../../space-kits/issue-tracker/). Huabu does not discover, serve, package or execute Kits itself. This adds no API, Skill resolver, Service package, Team runtime, Task/Run/View, or desktop resource pipeline. The installer uses an existing Node 24.16+ runtime with no dependencies, resolves package inputs relative to its own file (not cwd or a Server-local checkout), and invokes the `huabu-rfs` CLI (`HUABU_RFS_ENTRY`) when present while falling back to native HTTP (`HUABU_RFS_URL` + `AGENTLET_TOKEN`). It automatically resolves the installer Agent's Node ID from `HUABU_THREAD_ID` when available.

`SKILL.md` owns installation procedure; assets own installed bytes. `kit.json` owns ID/version; the helper hashes its exact runtime inputs for mismatch detection. There is no signed publication or upgrade loader. The old Issue Tracker Team Skill, prompt and safety preamble moved into the Kit and were rewritten from the current Space workflow; obsolete manifest/renderer were removed. Other retained Team packages are unchanged.

Static content includes Coordinator role, common instructions, lazy fixing safety contract and single-Agent-node issue layout. Editable configuration contains repository identity, checkout/worktree paths, Coordinator and Fixing Profiles (`coordinatorProfileId` and `fixingProfileId`), and delivery refs, with evidence and user confirmation. No project branch, toolchain, architecture directory, Profile ID or machine path is assumed. The Coordinator inherits its selected Profile's cwd, not a path copied from the Kit checkout.

## Installation boundaries

The helper previews by default; `--apply` authorizes its ordinary RFS writes after the Agent has obtained user installation approval. Preflight requires complete bounded node/edge inventory, excluding only the identified installer Agent. An unrelated non-empty Space blocks installation. This conservative implementation caps inventory at the RFS maximum and stops rather than treating truncation as empty.

An ordinary Installation Record Note stores Kit/version/digest, instance/installer/Profile identity, role-to-node/thread mapping, content baselines, completed steps, configuration state and pending mutation intent. It is editable coordination data, not protected metadata or authorization. One active installer/one instance is supported; CAS detects ledger changes but does not provide concurrent exactly-once semantics.

Each mutation persists intent first, then records acknowledgement. An uncertain/rejected mutation can leave durable partial state and blocks automatic retries. Acknowledged prefixes resume. Missing/deleted/edited static content, parent changes, unexpected edges and version conflicts stop without repair or overwriting. Configuration is the intended editable exception. A same-version unchanged rerun performs no writes. No rollback, automatic upgrade, adoption-by-label, overlay installation or destructive cleanup is provided.

## Three-step layout, configuration, and activation

Installation separates Space layout from Coordinator creation so the user does not have to supply Profile IDs or repository paths before seeing the configuration Frame on the canvas:

1. **Step 1 (Layout)**: The helper creates instruction Frames under inactive labels, copies direct child Notes and the editable amber **Issue Tracker Configuration** Frame, arranges Frames using structured layout, and stops in `state: "needs_configuration"` with `coordinator: null`.
2. **Step 2 (Configure)**: The user edits **Issue Tracker Configuration** on the Space, selecting external `coordinatorProfileId` and `fixingProfileId` and supplying repository, path, and branch values with evidence and confirmation.
3. **Step 3 (Finalize)**: Rerunning the helper with `--apply` validates the configuration, creates a fresh fixed external Coordinator (`noStart` / `X-Huabu-Agent-Start: false`, without parent lineage or host-thread correlation) using `coordinatorProfileId`, connects its specific Prompt Frame, activates the recognized instruction labels, and marks the Installation Record `ready`. (An optional `--profile PROFILE_ID` flag can still pre-create the idle Coordinator earlier if explicitly requested.)

Common Prompt is global; Coordinator Prompt has exactly one direct Agent neighbour; the fixing Skill is lazy. The installer never sends prompts, warm-ups or mode/model/config controls. Prompt capture/realization behavior remains the existing [Agent Context](./agent-context.md) contract.

Amber Frame/Text warnings and field-level REQUIRED/INVALID/UNVERIFIED diagnostics expose incomplete configuration. `ready` requires structurally valid evidenced/user-confirmed configuration and verified object/topology/geometry state, including the created and wired Coordinator. Color is not a technical launch interlock; the user must not interact with the Coordinator before configuration and topology are `ready`. Structural checks do not prove a remote filesystem or user-authored evidence true; the Coordinator verifies Git/path/device facts before creating an execution environment. Existing execution units retain their saved delivery identities even after configuration changes.

## Installed issue workflow

Each issue execution unit on the Space is represented by a **single Fixing Agent node** placed directly inside the `Issues` Frame (horizontal row, fixed size `400x300` rather than auto height), without a per-issue Frame or a separate Execution Note node. The installed **Issue Frame Layout** asset is the naming authority: Fixing Agent node labels use `<status emoji> <issue identity> · <stable issue title>`. Lifecycle is carried only by 🛠/🟣/⛔/🚀/✅, without status words or `Fixing Agent`/`Agent`/`Issue Frame` suffixes, and complete Agent labels are at most 80 characters. The setup Coordinator has no issue identity and retains its role label.

Coordinator dispatch is acceptance-only and asynchronous: pass all authoritative execution identities (`Issue`, `Worktree`, `Branch`, `Base ref @ SHA`, `PR Base`, `Fixing Profile`, `Agent Node ID`, `Agent Thread ID`) and the user-confirmed objective directly in the Fixing Agent's initial prompt, confirm prompt acceptance and the existing Thread, stop consuming the stream, and return control. Disconnecting delivery is not cancellation of the durable turn. The Coordinator does not buffer final-answer SSE output, wait for a final answer or poll for status. This is installed Agent guidance using existing RFS, not a new installer dispatch API. The installer itself never prompts an Agent.

Acceptance must be observable under the live transport contract; HTTP success or a Thread announcement alone is insufficient. The current RFS prompt stream does not expose the service's internal acceptance promise as a distinct acknowledgment, so dispatch confirmation must be reported as blocked if the available live contract provides no such signal. This Kit change does not add that runtime capability or claim provider-level dispatch validation.

The Fixing Agent reports investigation findings, root cause, and the minimal implementation plan directly in its own Agent chat for user confirmation (and in the PR body when a PR is prepared, or a GitHub issue comment when authorized) and updates its compact Agent node label (`🟣`, `🛠`, `⛔`, `🚀`) before ending each milestone turn. Status reconciliation occurs on user request, an available runtime notification, or before a dependent action; receiving a final response/notification is not required for durable handoff and does not prove execution completion. Only the Coordinator sets `✅` after verifying completion.

Kit 0.3.0 carries the single-Agent-node issue workflow (removing per-issue Frames and Execution Notes), the three-step installation flow, `huabu-rfs` CLI transport integration, and the compact naming/asynchronous dispatch contracts. A previous version/digest is not silently upgraded or rewritten; existing installations still require an explicit reconciliation decision.

## Code entry points

| File                                                                                             | Responsibility                                                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [`SKILL.md`](../../space-kits/issue-tracker/SKILL.md)                                            | Installer trigger, procedure, approval and recovery boundaries         |
| [`scripts/install.mjs`](../../space-kits/issue-tracker/scripts/install.mjs)                      | Package-local preview/materialization through existing RFS             |
| [`assets/`](../../space-kits/issue-tracker/assets/)                                              | Portable installed contracts/Prompts and configuration schema/template |
| [`tests/`](../../space-kits/issue-tracker/tests/)                                                | Content/configuration and real RFS/storage/topology acceptance         |
| [`rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts)                           | Existing unmodified RFS transport                                      |
| [`space-instruction-frames.ts`](../../apps/server/src/modules/agent/space-instruction-frames.ts) | Existing unmodified Prompt/Skill scoping and budgets                   |
