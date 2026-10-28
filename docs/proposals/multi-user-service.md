# Multi-User Service

Status: Proposed
Last updated: 2026-10-28

Follows PR #237 (Bubble identity and per-user Space access) toward issue #228. Two stacked pull requests take one Huabu Server from "several people sign in and each edits their own Spaces in one shared Workspace" to a service several people can use day to day: each person has their own Workspaces, uses agents in them, and an operator admits people without scripts.

Nothing changes in local mode (`HUABU_IDENTITY_PROVIDER=local`). Desktop and single-owner deployments keep one process-active Workspace, the same routes and the same UI.

## What "ready for several users" means

After both PRs, in Bubble mode:

| Outcome                                                                                                                                   | PR  |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Each admitted person gets a personal Workspace on first sign-in and can create, rename, switch and delete Workspaces they own.            | A   |
| Two people work in different Workspaces at the same time. One person switching never moves another person.                                | A   |
| Members run agents and conversations. An agent reaches only what the person who started it may reach.                                     | B   |
| Connected credentials and service leases are per person. One person's agent never uses another's GitHub token or service key.             | B   |
| A system owner admits members, revokes them and grants Workspace ownership from Settings.                                                 | B   |
| A session that expires mid-edit is renewed without leaving the page, so unsaved edits survive. Sign-out can end the provider session too. | B   |

Out of scope for both: sharing a Workspace or Space between people beyond operator grants, quotas and billing, and Desktop as a multi-user client.

## PR A — Request-scoped Workspaces

### The Workspace a request runs in

Each request runs in exactly one Workspace, resolved once in admission and carried in an `AsyncLocalStorage` context (`modules/workspace/context.ts`, new). `getWorkspaceHandle()`, `getWorkspacePath()`, `getWorkspaceKey()` and `space()` read that context. The rest of the Server's ~145 `space(canvasId)` call sites stay as they are.

How the Workspace is chosen:

- **Local mode:** the process-active Workspace, as today. Switching still changes it for every client, because local mode has one person.
- **Bubble mode:** the principal's _current Workspace_, a per-principal preference stored in Huabu (`principal_preferences`, referencing Bubble's `principalId`, as #228 proposes). Switching changes only that preference. It must be a Workspace the principal can read (`huabu.workspace.read`, new), else admission falls back to their personal Workspace.

A per-principal preference rather than a Workspace header keeps images, frames, downloads and EventSource working without changes, since they cannot set headers. The cost is that one person's tabs share one current Workspace, which is also the behavior today. Per-tab Workspaces would need the Workspace in every URL and are not planned.

Work that outlives the request (agents, memory updates, Task Runs, preprocessing, World preview reconciliation) captures the Workspace when it starts and runs inside it via `runInWorkspace(handle, fn)`. This replaces today's failure mode, where a switch mid-run either retargets the work or fails it with "inactive workspace".

### Storage

- **SQL namespaces per call, not per connection.** `useWorkspace()` mutates the one Postgres/SQLite connection's namespace today, so concurrent Workspaces would read each other's Spaces. The structured store reads the Workspace id from the context per query, and transactions bind it when they open. The one database-wide write order (`pg_advisory_xact_lock(WRITE_LOCK)`) stays: it also covers name allocation and the Workspace registry. A per-Workspace lock is a later throughput change.
- **Per-Workspace state.** The World id, canvas-dirs index, user-skill cache, external-note sessions and the Space-create and hierarchy chains move into a `WorkspaceRuntime` (`modules/workspace/runtime.ts`, new), created on first use per Workspace and evicted when idle. The process-wide reset hooks (`refreshCanvasDirIndex`, `invalidateUserSkill`, `resetExternalNoteSessions`) become methods on it.
- **Leases.** `acquireWorkspaceOperationLease()` counts per Workspace. It still stops a local-mode switch or a Workspace delete from stranding in-flight work, and no longer refuses a second live Workspace.
- **Blob prefixes use the Workspace id.** Azure blobs are prefixed by `getWorkspaceKey()`, which on Disk is the folder _path_, so moving a folder orphans them. This becomes the Workspace id, with a one-time copy-forward on first open.
- **Maps keyed by Space id alone** (canvas mutex, SSE listeners, memory worker, dir handles, tombstones, Agenetes turn owners) stay as they are. Space ids are random UUIDs or `createId('canvas')` and imports mint new ids. Workspace creation refuses a Disk folder whose Space ids collide with a live Workspace's.

### Roles and capabilities

This replaces #237's model. Huabu checks four capabilities, and the same names apply on a Workspace and on a Space:

| Capability     | Allows                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `huabu.read`   | Seeing and opening the Workspace or Space, every `GET`, search, live streams.                                           |
| `huabu.write`  | Editing Spaces and creating them. From PR B, also running agents and conversations in them.                             |
| `huabu.manage` | Renaming and deleting it, granting roles on it. On a Workspace, also its memory, Skills and Workspace settings.         |
| `huabu.admin`  | System target only: deployment, Canary, folder Workspaces on the Server's filesystem, and People administration (PR B). |

Roles:

| Role                     | Granted on    | Gives                                                                                                            |
| ------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `owner` (Bubble core)    | system        | `huabu.use`, `huabu.admin`. Bubble's system-owner rule also gives every capability on every Workspace and Space. |
| `member` (Bubble core)   | system        | `huabu.use`: admitted, and gets a personal Workspace.                                                            |
| `huabu.workspace.owner`  | one Workspace | read, write, manage                                                                                              |
| `huabu.workspace.editor` | one Workspace | read, write                                                                                                      |
| `huabu.workspace.viewer` | one Workspace | read                                                                                                             |
| `huabu.space.owner`      | one Space     | read, write, manage on that Space and the Spaces inside it                                                       |

- **Inheritance.** read, write and manage flow down Workspace → root Space → child Space, never up or sideways.
- **Who grants.** Granting a role on a Workspace or Space needs `huabu.manage` on it. Granting system roles needs `huabu.admin`. A member can therefore grant roles on their own Workspace. Neither PR adds a UI for that: sharing UI is a later step.
- **Admission.** Still system `member` or `owner`. A Workspace or Space grant alone does not admit anyone.
- **Space ownership on creation.** Creating a Space in a Workspace you can write claims `huabu.space.owner` on it, as in #237. This keeps a shared Space reachable by its creator if the Workspace grant is later narrowed.
- **Workspace-qualified Space targets.** `huabu.space` targets are `<workspaceId>:<canvasId>`, and the parent of a root Space is its own Workspace, not "the active one". So a Space can be shared later without sharing its Workspace.
- **Migration from #237.** On first start, `huabu.space.owner` grants are rewritten to qualified targets in the Workspace that holds each Space. `huabu.workspace.owner` grants keep their meaning. A #237 grant that names no existing Space is dropped.
- **Later goal, not in these PRs.** Every request names its Workspace explicitly. Until then a request runs in its caller's current Workspace, and a Space shared from another Workspace is reached by switching to that Workspace.

### Workspaces for members

- **Personal Workspace.** On a member's first admitted request with no readable Workspace, Huabu creates "<name>'s Workspace" and grants them `huabu.workspace.owner` on it, under a per-principal lock so two first requests create one.
- **Management.** `GET /api/workspaces` lists the Workspaces a caller can read. Any member may create one. Activating needs `huabu.read`; rename and delete need `huabu.manage`. Folder picking and path validation need `huabu.admin`, because they reach the Server's filesystem. On Disk storage, a member's new Workspace goes under the data directory.
- **System owner.** A system owner can reach every Workspace through Bubble's system-owner rule, and has a current Workspace like anyone else.

### Agents in PR A

Agents stay owner-only for members, as in #237. Each run now carries its Workspace: the reachback URL becomes `/api/rfs/w/<workspaceId>/<canvasId>`, and RFS runs the call in that Workspace. An owner's agent therefore keeps working when the owner switches away mid-run, instead of failing or reading the other Workspace.

### Web

- Boot no longer activates `registered[0]` in Bubble mode: the Server has already chosen the caller's current Workspace.
- The switcher lists the caller's Workspaces and is enabled for members. Switching posts to `/api/workspaces/:id/activate`, which in Bubble mode sets only the caller's preference.
- The Home folder name and `GET /api/workspace` path are withheld from members, closing a #237 limitation.

### Proof

The Postgres suite runs two principals in two Workspaces concurrently: creates, edits, SSE, search and uploads, with no cross-reads and no transaction aborts. It also checks that a switch in one browser leaves the other unchanged, that an owner's agent keeps its Workspace across the owner's switch, that #237 grants migrate, that a viewer cannot write and an editor cannot rename or delete, that personal Workspaces are created once under concurrent first requests, and that local mode's screenshots stay pixel-identical to `main`.

## PR B — Members use agents, and the service is administrable

### Per-run agent credentials

Each agent run gets its own token, minted by the Server when the run starts. It names the requesting principal, the Workspace, the root Space and the thread, and expires with the run. The Agentlet passes it as the reachback credential instead of the machine token. RFS admits it as that principal, and Space access is checked as for that person's browser requests, so an agent can read or edit only what its starter can. The machine token keeps unrestricted reach only for the Agentlet's own control surface, never for Space content.

This reopens `/api/agent`, `/api/acp`, `/api/agent-change-review` and Interactive View actions to members. It also covers the memory worker: a member's edits drive memory updates again, running in that person's Workspace under their authority.

### Per-person credentials

Model configuration and LLM keys, connected credentials, service-package leases and integration configuration move from data-directory scope to per principal in Bubble mode. Each person configures their own models and keys in Settings, and an agent run resolves models from its starter's configuration. A member with no model configured sees the Agent tool explain that, not a Server error. Operator-only settings (deployment, Canary, Workspaces on the Server's filesystem) stay system-owner-only. Settings shows a member only their own configuration.

### Grant administration

A Settings → People panel for system owners lists principals, and admits (`member`), revokes, and grants or removes `huabu.workspace.owner`. Huabu proxies these to Bubble's grant API in-process. Revoking `huabu.use` closes that person's open streams at the next revalidation, as #237 already does for Space grants.

### Session lifecycle

- **Refresh.** The sign-in flow requests a refresh token (`offline_access`), the Server holds it beside the access token in the session, and it renews the access token before it expires.
- **Re-sign-in in a popup.** When renewal is impossible, a lapsed session re-signs in through a popup, keeping the page and its unsaved edits.
- **Provider logout.** Sign-out optionally ends the provider session (RP-initiated logout) when the provider advertises `end_session_endpoint`.

### Proof

A member runs an agent that tries to read another member's Space through RFS and is refused. Their agent edits their own Space. Two members' connected credentials stay separate. An owner admits and revokes a member from the UI, and the revoked member's open page loses access within 30 seconds. A session that expires mid-edit renews or re-signs in without losing the edit. All of it is checked against real Auth0 and Entra sign-ins, as in #237.

## Settled decisions

Confirmed 2026-10-28:

1. **Current Workspace per person, not per tab.** A Workspace in every URL was rejected as a much larger web and API change for a rare need.
2. **Workspace-qualified Space grants,** with an in-place migration of #237's grants, rather than relying on unique Space ids. Space grants stay so that one Space can be shared later. #237's roles are replaced by the model above.
3. **Automatic personal Workspace on first sign-in,** rather than no Workspace until an operator grants one.
4. **Per-person model keys** in PR B, rather than every member's agents using the operator's keys.

## Code entry points

| File/dir                                                                                                               | Responsibility                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`modules/workspace.ts`](../../apps/server/src/modules/workspace.ts)                                                   | Today's process-active Workspace; becomes the local-mode default and the context reader. |
| [`modules/storage/storage.ts`](../../apps/server/src/modules/storage/storage.ts)                                       | Storage facade, `space()`, World id, `activateWorkspace`.                                |
| [`modules/storage/backends/postgres/database.ts`](../../apps/server/src/modules/storage/backends/postgres/database.ts) | Connection namespace (`useWorkspace`) and write lock.                                    |
| [`modules/identity/resources.ts`](../../apps/server/src/modules/identity/resources.ts)                                 | Space parent resolution for Bubble inheritance.                                          |
| [`modules/identity/bubble.ts`](../../apps/server/src/modules/identity/bubble.ts)                                       | Huabu roles, capabilities and claims.                                                    |
| [`modules/security/space-access.ts`](../../apps/server/src/modules/security/space-access.ts)                           | Per-request Space guard and agent refusal.                                               |
| [`modules/agent/acp/reachback-env.ts`](../../apps/server/src/modules/agent/acp/reachback-env.ts)                       | Agent reachback URL and credential.                                                      |
| [`modules/workspaces.route.ts`](../../apps/server/src/modules/workspaces.route.ts)                                     | Workspace list, create, activate.                                                        |
| [`apps/web/src/store/workspaceStore.ts`](../../apps/web/src/store/workspaceStore.ts)                                   | Web boot and switch.                                                                     |
