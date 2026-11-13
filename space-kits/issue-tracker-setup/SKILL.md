---
name: issue-tracker-setup
description: 'Install an Issue Tracker into a blank Huabu Space from this cloned Kit, or finish its configuration and resume an acknowledged partial installation. Use when asked to initialize an Issue Tracker Space. Do not use to investigate or fix repository issues, run the installed Coordinator, upgrade an existing installation, or overwrite a non-empty Space.'
---

# Set Up Issue Tracker

This Kit initializes **one existing Space**, not a Workspace or a repository. The user supplies the GitHub repository and Kit path; clone the requested revision into an unused directory, record its commit, and locate this file. No built-in discovery, package service, desktop integration, or Huabu source-checkout working directory is required. All paths below are relative to this file.

## Prepare

Load the **authenticated** Huabu root guide, including live Skills, using `node "$HUABU_RFS_ENTRY" get-skill` (or native HTTP if `HUABU_RFS_ENTRY` is absent). Load the live `agents` guide and capability details for the operations this installer uses: `INSPECT_NODES`, `INSPECT_EDGES`, `CREATE_NODES`, `MERGE_NODE_DATA`, `SET_FRAME_LAYOUT`, and `CONNECT_NODES`. Follow current guidance; a rejected operation is not permission to guess a replacement.

Read [the installer](./scripts/install.mjs) before executing it. It is a dependency-free Node script, not a document to paste into a Prompt. Use an existing Node 24.16+ runtime; never install a runtime merely for Huabu access. If that runtime is unavailable, stop and explain the requirement. The script resolves its assets relative to itself, independently of cwd, and uses `HUABU_RFS_ENTRY` when present (falling back to native HTTP via `HUABU_RFS_URL` and `AGENTLET_TOKEN`).

Confirm installation authorization and the destination Space. The installer automatically resolves the current installer Agent's Node ID from `HUABU_THREAD_ID` when present; pass `--installer-node NODE_ID` only if `HUABU_THREAD_ID` is absent. You do **not** need a Profile ID or repository paths before laying out the Space.

## Step 1. Lay out Space content

Run a read-only preview first without `--apply`:

```bash
node ./scripts/install.mjs
```

The script reads complete bounded inventory, lists selectable external Agent Profiles, and prints an installation plan without writes. Blank means only this identified installer Agent and no edges. An unbound Question, another Agent, a Note, a Frame, or truncated inventory is not blank. A unique matching Installation Record enables resumption; unrelated content or conflicting package identity blocks installation.

After confirming the preview, execute with `--apply` to lay out the Space content:

```bash
node ./scripts/install.mjs --apply
```

This creates native Frames/Notes/Text, the empty `Issues` area, and the `Issue Tracker Installation Record` Note. Instruction Frames have their final recognized titles from creation: `prompt: issue tracking common`, `prompt: issue tracking coordinator`, `skill: issue fixing`, and the amber `prompt: issue tracking configuration`. Do not rename them during onboarding. It copies installed Markdown bytes verbatim from [assets](./assets/coordinator-prompt.md); do not regenerate or summarize them.

Install the current single-Agent-node layout, naming, and asynchronous-dispatch contracts unchanged: each issue is represented by a single Fixing Agent node inside the `Issues` Frame (no per-issue Frame and no Execution Note node), and **Issue Frame Layout** owns its compact `<status emoji> <issue identity> · <stable issue title>` label. The installed Coordinator passes execution identities in the initial prompt and returns after prompt acceptance/Thread confirmation rather than waiting for a Fixing Agent's final answer; the Fixing Agent reports findings/plans directly in chat and updates its own Agent node label. These rules apply to future issue units, not the setup Coordinator's issue-free label. Do not copy older `Fixing Agent`/`Issue Frame` label suffixes, Execution Note contracts, or synchronous waiting instructions from a previous installation.

When run before configuration is filled in, Step 1 stops cleanly in `state: "needs_configuration"` with `coordinator: null`. The recognized instruction titles are already in place; only Coordinator creation waits for configuration. `--profile PROFILE_ID` can override the Coordinator selection but never bypasses valid confirmed configuration.

## Step 2. Fill in configuration on the Space

The amber `prompt: issue tracking configuration` Frame contains only the editable **Issue Tracker Configuration** Note, using the [Markdown table template](./assets/configuration.md). It is the single source of configuration: no user-maintained JSON copy. As a direct Note child of a Prompt Frame its body is included in the Agent's initial Prompt. A separate root-level Text node, outside every Prompt/Skill Frame, explains required fields, defaults, confirmation, and the available external Profile names/IDs. Do not put onboarding instructions inside an instruction Frame. Missing, invalid, or unverified values are reported by field, along with `availableProfiles` from the installer output.

Guide the user to edit only the **Value** column in the existing **Issue Tracker Configuration** Note. Keep the **Field** keys unchanged; blank optional cells mean use defaults/derivation, not the literal string `null`. Only two fields are required upfront (`codebasePath` and `fixingProfileId`):

- `codebasePath` (**required**): absolute path to the local Git repository on the intended execution device.
- `fixingProfileId` (**required**): explicit selectable external Profile ID (never `huabu` or an inferred alias). Also used for the Coordinator unless `coordinatorProfileId` is set.
- `coordinatorProfileId` (_optional_): defaults to `fixingProfileId` when `null`.
- `repository` (_optional_): `owner/repo` override; when `null`, the Coordinator derives it from `codebasePath` Git remotes (and asks for confirmation if remotes such as fork `origin` vs `upstream` are ambiguous).
- `worktreeRoot` (_optional_): absolute parent directory for issue worktrees; when `null`, defaults to `<codebasePath>-worktrees`.
- `developmentBaseRef` and `pullRequestBase` (_optional_): default to `"origin/main"` and `"main"`. Override them when the project uses a custom branch workflow (such as `origin/alpha` + `alpha` or `origin/develop` + `develop`); once configured, the Coordinator enforces those exact refs and fails closed rather than silently falling back.
- `confirmedByUser`: change the table cell from `false` to `true` after the user confirms the configuration.

Do not copy the Kit repository's settings, guess a default branch, insert host paths, or treat a Server-local check as evidence about another machine. Read the target repository's own instructions; do not impose Huabu's architecture directories, package manager, checks, or Canary policy. Edit the existing configuration Note, not another copy. Validation checks shape, selected Profiles and confirmation; the Coordinator must still verify Git/path/device facts on the intended device before creating an execution environment.

## Step 3. Finalize installation and create Coordinator

Once the configuration Note is updated, preview validation without `--apply`:

```bash
node ./scripts/install.mjs
```

When `configurationState` is `valid`, run with `--apply` to finalize the installation:

```bash
node ./scripts/install.mjs --apply
```

Using the validated `coordinatorProfileId` (or `fixingProfileId` when the override is blank, or `--profile PROFILE_ID`), the script creates the fresh idle Coordinator with `noStart` (`X-Huabu-Agent-Start: false`), no prompt, no parent lineage, and no host-thread correlation; labels it `Issue Tracker Coordinator`; connects its specific Prompt Frame; turns the configuration Frame green; and records `state: "ready"` in the Installation Record. Frame titles never change. Common and configuration instructions are global, and the fixing contract is a lazy Skill Note. No prompt, warm-up, mode/model/config control, or implementation authorization is sent.

Require `state: "ready"` with no unresolved write intent, valid configuration, expected direct Prompt adjacency, complete object mappings and no unexpected edges. The installer checks queried geometry for containment/non-overlap. Review the visible Space as well: browser text measurement may refine content-driven heights after headless installation. Report the installed Coordinator Node/Thread, package identity, configuration state and limitations. Only then invite the user to send the Coordinator its **first message**.

Space Prompt is captured at first realization, including external mode/model/config controls, not node creation. Do not use the already-realized installer as Coordinator. Color communicates setup status; it is not a technical launch lock. Configuration changes after readiness invalidate the prior configuration hash until revalidated with `node ./scripts/install.mjs --apply`. The Coordinator must read the current mapped configuration Note before new work, not rely on its initial Prompt snapshot. If the user already interacted with the Coordinator before configuration/topology completion, stop: editing the Space does not replace its frozen Prompt; agree on a replacement Agent rather than silently continuing.

## Failure and rerun boundaries

Only one installer may run at a time; there is one Kit instance per Space. Do not edit the installation while the script is running. Sequential same-version reruns reuse recorded IDs, preserve user content/layout, and perform no writes when unchanged. The installer does not overwrite edited or restore deleted static assets. Configuration is deliberately editable and revalidated.

RFS is not transactional. Accepted commands, the Coordinator, and ledger writes are separate durable boundaries. The script saves intent before each mutation and inspects every command result. A dropped response or rejected write may leave partial state. **Never blindly retry, delete, clear pending intent, or adopt an object by label.** Re-query actual state, explain the pending operation, and obtain an explicit recovery decision. Automatic recovery is limited to previously acknowledged steps with a saved mapping. Creation of the first Installation Record itself can lose its acknowledgement; an incomplete record blocks automatic adoption.

Version/digest mismatch blocks upgrades. No automatic three-way merge, concurrent installation, non-empty overlay mode, general blueprint runtime, or rollback is included. Do not add product-side loaders to work around these limits.

Installing this Kit is not approval to fix an issue. The installed Coordinator owns runtime coordination; the [safety contract](./assets/fixing-agent-preamble.md) owns Fixing Agent authorization. For requests such as "fix issue 12" or "approve that implementation", use the existing execution conversation, not this installation Skill.
