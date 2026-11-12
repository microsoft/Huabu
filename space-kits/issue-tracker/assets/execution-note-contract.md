# Issue Execution Note Contract

One Note records each execution unit's user outcome, identities, approval and low-frequency milestones. Technical assertions remain subject to investigation and confirmation.

Keep the Note label and first heading identical: `<status> · <issue identity> · <stable issue title>`. Use these status prefixes:

- 🛠 In Progress
- 🟣 Approval Needed
- ⛔ Blocked
- 🚀 PR Prepared
- ✅ Completed

Keep issue identity and the Note's stable audit title unchanged. Frame and Agent use the compact Layer labels defined in **Issue Frame Layout**, not this Note's full status text. Their shared display title may be shortened only to satisfy that contract's Agent-label budget without losing issue identity.

```markdown
# <status> · <issue identity> · <stable issue title>

## Objective

<user-observed problem, desired outcome, and confirmed execution boundary>

## Execution

- Issue: <identity or URL>
- Worktree: `<absolute path on the execution device>`
- Branch: `<issue branch>`
- Base: `<development base ref>` @ `<base commit SHA>`
- PR Base: `<pull-request target branch>`
- Agent Profile: <display name> (`<profile id>`)
- Agent Node: `<node id>`
- Agent Thread: `<thread id>`

## Current result

<latest evidence, approval record, milestone, blocker, or PR result>
```

The Coordinator creates the Note in-progress. Objective and execution identity fields are Coordinator-owned; the Fixing Agent fills initially pending Agent identities when supplied and otherwise preserves them. Existing units retain creation-time Base/PR Base. Reconciliation and explicit user approval are required to retarget them.

The Fixing Agent uses approval-needed for an evidence-backed plan/material decision, in-progress after overall-plan approval, blocked for an external condition, and PR-prepared after pushing and creating/updating the PR against the recorded target. The Coordinator alone marks completed after explicit user confirmation or a completion condition authorized in advance. A finished Agent turn, clean worktree, commit, push or open PR is not completion.

Before every update, download the latest Note and authored revision; submit the authored body only with a revision guard. Preserve stable fields and user changes. Update label, first heading and Current result together, and synchronize both compact Agent and Frame labels to the same lifecycle emoji. Re-query actual labels and geometry after changes. On conflict, re-read and reconcile rather than overwrite.

The Coordinator dispatches asynchronously and may disconnect after acceptance and confirmation of the existing Thread identity. It does not wait for, poll, or depend on the final answer. Before ending each milestone turn, the Fixing Agent must durably record findings, decisions and the next required action in this Note and synchronize both Layer labels. Do not rely on the Coordinator receiving the final response or a runtime notification. Reconcile status when the user asks, a runtime notification is available, or a dependent action requires it; a notification is a reconciliation trigger, not proof of completion.

For approval-needed, record observed behavior/root cause, proposed minimal scope, relevant/rejected criteria, exclusions, validation and exact approval requested; highlight material conflicts. After approval, record the approved boundary and apply the Fixing Agent Safety Contract's scoped delivery authority. For blocked, state the condition/input required. For PR-prepared, record URL, head branch/SHA, recorded target, relevant commits, validation and limitations.

For older Notes missing Base/PR Base, the Coordinator reconciles from verified Git history and the actual delivery target; never substitute today's common configuration. This Note is coordination data, not an authoritative technical specification or a grant of additional permissions.
