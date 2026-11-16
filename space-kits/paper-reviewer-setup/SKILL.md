---
name: paper-reviewer-setup
description: 'Install a Paper Reviewer into a blank Huabu Space. Use when asked to set up a paper-reading and bilingual review Space. Do not use to review a paper, search for literature, or overwrite an existing Space.'
---

# Set Up Paper Reviewer

This Kit installs ordinary editable Space content, not a Profile, Team, service, or new runtime. Resolve files relative to this cloned Kit and record the selected repository revision in chat. Read the assets before installation; installation does not approve any review submission or publication.

## Preflight

Load the authenticated root guide, the live `agents` guide, and focused command guidance before using RFS. Query the complete bounded node/edge inventory and identify this installer Agent from the supplied Thread identity. The automatic path requires a blank Space apart from that Agent and no edges. On unrelated content, truncated inventory, or an ambiguous installer identity, stop and agree on a destination rather than overlaying or deleting content.

Ask the user to select an available external Profile for the new Paper Reviewer and confirm the installation plan below. Do not guess its ID, provision a Profile, install dependencies, or reuse the already-realized installer as the Reviewer. The selected Profile's working directory remains its own; no Kit-checkout path is injected.

## Install

Use ordinary `CREATE_NODES` operations, retaining the returned IDs in chat. Copy asset bodies verbatim; do not summarize them or include Huabu sidecar frontmatter.

| Object                         | Content and purpose                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `prompt: paper reviewer` Frame | One direct Note child **Paper Reviewer Instructions**, from [role-prompt.md](./assets/role-prompt.md)   |
| `skill: paper review` Frame    | One direct Note child **Paper Review Workflow**, from [review-workflow.md](./assets/review-workflow.md) |
| `Papers` Frame                 | Initially empty; the user adds papers here                                                              |
| `Discussion` Frame             | Initially empty; user questions and evidence-grounded discussion notes                                  |
| `Review Drafts` Frame          | Initially empty; user-reviewed bilingual drafts                                                         |
| `Paper Reviewer` Agent         | Fresh idle Agent using the selected Profile                                                             |

Place the Prompt and Reviewer together; keep the Skill nearby and the three work areas to the right in reading order. Use measured geometry, at least 24px between siblings, and enough Frame title/padding space. Notes may have fixed height; the Agent has width 400 and content-driven height. Do not put papers or onboarding instructions inside instruction Frames.

Create the Agent without a prompt (`--no-start` / `X-Huabu-Agent-Start: false`), parent lineage, or host-thread correlation. Connect only the dedicated Prompt Frame directly to the new Agent. The Skill remains lazy and needs no edge. Never start, warm up, or send model/mode/config controls before the topology is complete.

## Verify and hand off

Query final nodes and edges. Require the exact direct child Notes, exactly one Agent neighbour for the Prompt (the Reviewer), no unintended edges, no overlap, and containment of each Note. Confirm the authenticated root guide lists **Paper Review Workflow** as a lazy Note. Read the installed Notes back and compare their authored bodies to the assets. The output must include the Reviewer Node/Thread IDs and selected Profile.

Return control with the Agent idle. Tell the user to add a paper and send the Reviewer its first request; setup does not itself review or publish anything. Runtime instructions are captured on first realization, so do not interact early.

If an operation fails or delivery is ambiguous, inspect the actual objects using the saved IDs and explain partial results before choosing the next action. Never blindly retry creation, replace an Agent, overwrite user content, or introduce an installation ledger/recovery subsystem.
