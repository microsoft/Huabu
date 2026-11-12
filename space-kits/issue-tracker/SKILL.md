---
name: issue-tracker
description: 'Install an Issue Tracker into a blank Huabu Space from this cloned Kit, or finish its configuration and resume an acknowledged partial installation. Use when asked to initialize an Issue Tracker Space. Do not use to investigate or fix repository issues, run the installed Coordinator, upgrade an existing installation, or overwrite a non-empty Space.'
---

# Install Issue Tracker

This Kit initializes **one existing Space**, not a Workspace or a repository. The user supplies the GitHub repository and Kit path; clone the requested revision into an unused directory, record its commit, and locate this file. No built-in discovery, package service, desktop integration, or Huabu source-checkout working directory is required. All paths below are relative to this file.

## 1. Prepare

Load the **authenticated** Huabu root guide, including live Skills, using the host-provided RFS invocation or native HTTP. Load the live `agents` guide and capability details for the operations this installer uses: `INSPECT_NODES`, `INSPECT_EDGES`, `CREATE_NODES`, `MERGE_NODE_DATA`, `SET_NODE_GEOMETRY`, `SET_FRAME_LAYOUT`, and `CONNECT_NODES`. Follow current guidance; a rejected operation is not permission to guess a replacement.

Read [the installer](./scripts/install.mjs) before executing it. It is a dependency-free Node script, not a document to paste into a Prompt. Use an existing Node 24.16+ runtime; never install a runtime merely for Huabu access. If that runtime is unavailable, stop and explain the requirement. The script resolves its assets relative to itself, independently of cwd.

Confirm installation authorization and the destination Space. Resolve the current installer Agent's actual Node ID from its thread association. Ask the user to select an available **external Coordinator Profile ID**; do not infer a device or inherit the installer's Profile. The Coordinator can inherit that Profile's cwd because project paths are configuration, not launch-time literals. The Fixing Profile may differ and is configured separately.

## 2. Preview

Run this without `--apply` first, substituting verified IDs:

```bash
node ./scripts/install.mjs --installer-node NODE_ID --profile PROFILE_ID
```

The script uses `HUABU_RFS_URL` and `AGENTLET_TOKEN`, reads complete bounded inventory, and prints an installation plan without writes. Blank means only this identified installer Agent and no edges. An unbound Question, another Agent, a Note, a Frame, or truncated inventory is not blank. A unique matching Installation Record enables resumption; unrelated content or conflicting package identity blocks installation.

The plan identifies native Frames/Notes/Text, the global common Prompt, Coordinator-only Prompt, lazy fixing Skill, empty Issues area, configuration, and a fresh idle Coordinator. It does **not** create Tasks, Runs, Views, example issues, worktrees, GitHub changes, or an active Agent.

## 3. Install

After confirming the preview, execute the same command with `--apply`. This is the only mode that writes:

```bash
node ./scripts/install.mjs --installer-node NODE_ID --profile PROFILE_ID --apply
```

The script copies installed bytes from [assets](./assets/coordinator-prompt.md); do not regenerate or summarize these assets. Its Installation Record stores Kit version/content digest, instance identity, actual role-to-node/thread mapping, baseline content hashes, configuration validation state, and pending write intent. Labels are navigation hints, never ownership proof.

Instruction Frames start with inactive labels. The script creates the Coordinator with `X-Huabu-Agent-Start: false`, no prompt, no parent lineage, and no host-thread header; connects its specific Prompt Frame; then activates instruction labels. Common instructions are global, and the fixing contract is a lazy Skill Note. No prompt, warm-up, mode/model/config control, or implementation authorization is sent.

## 4. Complete configuration

The amber **Issue Tracker Configuration** Frame contains the editable [configuration template](./assets/configuration.md) and a conspicuous Text warning. Missing, invalid, or unverified values are reported by field. The Coordinator exists but must remain untouched until configuration and topology are complete.

Distinguish static assets from project values. Derive repository identity and candidate delivery refs only from auditable project evidence; ask the user to confirm them. Require checkout/worktree paths and Fixing Profile on the correct execution device. Do not copy the Kit repository's settings, guess a default branch, insert host paths, or treat a Server-local check as evidence about another machine. Read the target repository's own instructions; do not impose Huabu's architecture directories, package manager, checks, or Canary policy.

Edit the existing configuration Note, not another copy. Values have explicit evidence and user confirmation. Validation checks shape, selected Profiles and confirmation; it cannot independently authenticate evidence or inspect another device. The Coordinator must still verify Git/path/device facts before creating an execution environment.

Run the same command without `--apply` to see current validation; use `--apply` to finish acknowledged installation steps and update the Installation Record. Configuration changes after readiness invalidate the prior configuration hash until revalidated. Other installed content is never automatically replaced.

## 5. Verify and hand off

Require `ready` with no unresolved write intent, valid configuration, expected direct Prompt adjacency, complete object mappings and no unexpected edges. The installer checks queried geometry for containment/non-overlap. Review the visible Space as well: browser text measurement may refine content-driven heights after headless installation. Report the installed Coordinator Node/Thread, package identity, configuration state and limitations. Only then invite the user to send the Coordinator its **first message**.

Space Prompt is captured at first realization, including external mode/model/config controls, not node creation. Do not use the already-realized installer as Coordinator. Placeholder color is a warning, not a technical launch lock. If the user already interacted with the Coordinator before configuration/topology completion, stop: editing the Space does not replace its frozen Prompt; agree on a replacement Agent rather than silently continuing.

## Failure and rerun boundaries

Only one installer may run at a time; there is one Kit instance per Space. Do not edit the installation while the script is running. Sequential same-version reruns reuse recorded IDs, preserve user content/layout, and perform no writes when unchanged. The installer does not overwrite edited or restore deleted static assets. Configuration is deliberately editable and revalidated.

RFS is not transactional. Accepted commands, the Coordinator, and ledger writes are separate durable boundaries. The script saves intent before each mutation and inspects every command result. A dropped response or rejected write may leave partial state. **Never blindly retry, delete, clear pending intent, or adopt an object by label.** Re-query actual state, explain the pending operation, and obtain an explicit recovery decision. Automatic recovery is limited to previously acknowledged steps with a saved mapping. Creation of the first Installation Record itself can lose its acknowledgement; an incomplete record blocks automatic adoption.

Version/digest mismatch blocks upgrades. No automatic three-way merge, concurrent installation, non-empty overlay mode, general blueprint runtime, or rollback is included. Do not add product-side loaders to work around these limits.

Installing this Kit is not approval to fix an issue. The installed Coordinator owns runtime coordination; the [safety contract](./assets/fixing-agent-preamble.md) owns Fixing Agent authorization. For requests such as "fix issue 12" or "approve that implementation", use the existing execution conversation, not this installation Skill.
