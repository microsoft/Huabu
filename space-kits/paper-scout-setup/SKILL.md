---
name: paper-scout-setup
description: 'Install a Paper Scout into a blank Huabu Space. Use when asked to set up a research-idea and related-work discovery Space. Do not use to run a literature search, review one paper, or overwrite an existing Space.'
---

# Set Up Paper Scout

This Kit installs ordinary editable Space content, not a Profile, Team, service, or search platform. Resolve assets relative to this cloned Kit and record its selected repository revision in chat. Read the assets and helper before installation. Setup does not approve any search or provider call.

## Preflight

Load the authenticated root guide, the live `agents` guide, and focused operation guidance. Query complete bounded node/edge inventory and resolve this installer Agent from its supplied Thread identity. The automatic path requires a blank Space apart from that Agent and no edges. Unrelated content, incomplete inventory, or an ambiguous installer blocks overlay installation; agree on a destination without overwriting content.

Ask the user to select an available external Profile and confirm the installation plan below. Its execution device needs an existing Node runtime with global fetch for the bundled helper; do not provision a runtime, install dependencies, or guess configuration. `OPENALEX_API_KEY` and `PAPER_SCOUT_EMAIL` are optional existing runtime inputs, never Note content. Do not change the selected Profile's working directory to the Kit checkout.

## Install

Create the following native objects through ordinary RFS commands and retain their returned IDs in chat. Copy Markdown asset bodies verbatim. The helper is installed as source code, not as instructions or a server-side executable.

| Object                      | Content and purpose                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt: paper scout` Frame | One direct Note child **Paper Scout Instructions**, from [role-prompt.md](./assets/role-prompt.md)                                                                                                                       |
| `skill: paper scout` Frame  | Direct Note **Paper Scout Workflow**, from [scout-workflow.md](./assets/scout-workflow.md), and direct Note **Paper Scout Helper** containing [paper-scout.mjs](./assets/paper-scout.mjs) in one `javascript` code fence |
| `Research Questions` Frame  | Initially empty; user-supplied ideas and search boundaries                                                                                                                                                               |
| `Candidate Papers` Frame    | Initially empty; identified sources and evidence                                                                                                                                                                         |
| `Comparisons` Frame         | Initially empty; bounded comparisons and uncertainties                                                                                                                                                                   |
| `Paper Scout` Agent         | Fresh idle Agent using the selected Profile                                                                                                                                                                              |

Do not duplicate the helper source inside the workflow Note. Preserve the complete helper bytes inside its fence; the runtime downloads that Note on demand, so the installed Space does not depend on the original clone remaining available.

Keep the Prompt adjacent to its Agent, the Skill nearby, and the three work areas to the right in reading order. Query actual geometry, leave at least 24px between siblings, and include Frame title/padding in containment. Use width 400 and content-driven height for the Agent; the helper Note can have fixed height with scrolling. Keep user papers and search results outside instruction Frames.

Create the Agent with no prompt, parent lineage, or host-thread correlation (`--no-start` / `X-Huabu-Agent-Start: false`). Connect only the dedicated Prompt Frame directly to the Scout. Do not connect the helper, work areas, or installer to it; the Skill remains lazy. No warm-up, mode/model/config control, search, or helper execution is part of installation.

## Verify and hand off

Query final nodes/edges and require the expected direct children, exactly one Agent neighbour for the dedicated Prompt, no unintended edges, no overlap, and Note containment. Confirm the authenticated root guide lists both lazy Skill Notes. Download the installed Notes; compare the Markdown bodies and fenced helper bytes to their canonical assets rather than relying on filenames or labels alone.

Report the Agent Node/Thread and selected Profile, leaving it idle for the user's first research question. The runtime workflow owns actual searches and writes results back through direct Space operations. Do not promise exhaustive coverage or novelty verification.

After a rejected command or uncertain delivery, inspect saved identities and actual state before deciding what remains. Preserve user content; never blindly recreate objects, replace an Agent, or add an installation recovery framework.
