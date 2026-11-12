# Space Kits

Space Kits are source-distributed, Agent-executed installation Skills. A user creates an Agent in an existing blank Space, supplies a trusted GitHub repository/revision and Kit path, and asks it to clone and follow `SKILL.md`. Installed content initializes that one Space, not a Workspace, a Profile installation or a new Huabu service.

```text
user supplies repository + Kit path
  -> Agent clones a chosen revision and reads SKILL.md
  -> read-only RFS preflight and installation plan
  -> approved package-local helper uses existing RFS
  -> native nodes + configuration + idle Coordinator
```

## Distribution and content

The first Kit lives in [`space-kits/issue-tracker/`](../../space-kits/issue-tracker/). Huabu does not discover, serve, package or execute Kits itself. This adds no API, Skill resolver, Service package, Team runtime, Task/Run/View, or desktop resource pipeline. The installer uses an existing Node 24.16+ runtime with no dependencies and resolves package inputs relative to its own file, not cwd or a Server-local checkout.

`SKILL.md` owns installation procedure; assets own installed bytes. `kit.json` owns ID/version; the helper hashes its exact runtime inputs for mismatch detection. There is no signed publication or upgrade loader. The old Issue Tracker Team Skill, prompt and safety preamble moved into the Kit and were rewritten from the current Space workflow; obsolete manifest/renderer were removed. Other retained Team packages are unchanged.

Static content includes Coordinator role, common instructions, lazy fixing safety contract, execution-note contract and layout. Editable configuration contains repository identity, checkout/worktree paths, Fixing Profile and delivery refs, with evidence and user confirmation. No project branch, toolchain, architecture directory, Profile ID or machine path is assumed. The user chooses an external Coordinator Profile before installation; its cwd is inherited, not copied from the Kit checkout.

## Installation boundaries

The helper previews by default; `--apply` authorizes its ordinary RFS writes after the Agent has obtained user installation approval. Preflight requires complete bounded node/edge inventory, excluding only the explicitly identified installer Agent. An unrelated non-empty Space blocks installation. This conservative implementation caps inventory at the RFS maximum and stops rather than treating truncation as empty.

An ordinary Installation Record Note stores Kit/version/digest, instance/installer/Profile identity, role-to-node/thread mapping, content baselines, completed steps, configuration state and pending mutation intent. It is editable coordination data, not protected metadata or authorization. One active installer/one instance is supported; CAS detects ledger changes but does not provide concurrent exactly-once semantics.

Each mutation persists intent first, then records acknowledgement. An uncertain/rejected mutation can leave durable partial state and blocks automatic retries. Acknowledged prefixes resume. Missing/deleted/edited static content, parent changes, unexpected edges and version conflicts stop without repair or overwriting. Configuration is the intended editable exception. A same-version unchanged rerun performs no writes. No rollback, automatic upgrade, adoption-by-label, overlay installation or destructive cleanup is provided.

## Instructions and activation

The helper first creates instruction Frames under inactive labels, copies direct child Notes, arranges Frames using existing structured layout, creates a fresh fixed external Coordinator with start disabled, connects its specific Prompt Frame, then activates recognized labels. Common Prompt is global; Coordinator Prompt has exactly one direct Agent neighbour; the fixing Skill is lazy. It does not send prompts, warm-ups or mode/model/config controls. Prompt capture/realization behavior remains the existing [Agent Context](./agent-context.md) contract.

Configuration can remain incomplete while the Coordinator exists idle. Amber Frame/Text warnings and field-level REQUIRED/INVALID/UNVERIFIED diagnostics expose that state. `ready` requires structurally valid evidenced/user-confirmed configuration and verified object/topology/geometry state. Color is not a technical launch interlock; the user must not interact with the Coordinator before completing configuration/topology. Structural checks do not prove a remote filesystem or user-authored evidence true; the Coordinator verifies Git/path/device facts before creating an execution environment. Existing execution units retain their saved delivery identities even after configuration changes.

## Code entry points

| File                                                                                             | Responsibility                                                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [`SKILL.md`](../../space-kits/issue-tracker/SKILL.md)                                            | Installer trigger, procedure, approval and recovery boundaries         |
| [`scripts/install.mjs`](../../space-kits/issue-tracker/scripts/install.mjs)                      | Package-local preview/materialization through existing RFS             |
| [`assets/`](../../space-kits/issue-tracker/assets/)                                              | Portable installed contracts/Prompts and configuration schema/template |
| [`tests/`](../../space-kits/issue-tracker/tests/)                                                | Content/configuration and real RFS/storage/topology acceptance         |
| [`rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts)                           | Existing unmodified RFS transport                                      |
| [`space-instruction-frames.ts`](../../apps/server/src/modules/agent/space-instruction-frames.ts) | Existing unmodified Prompt/Skill scoping and budgets                   |
