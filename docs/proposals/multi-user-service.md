# Multi-User Service

Status: In-Progress — PR A (#356) merged, PR B (#357) implemented for review
Last updated: 2026-11-04

Follows PR #237 (Bubble identity and per-user Space access) toward issue #228. PR A (#356) is merged; PR B (#357) now targets `main`. Together these pull requests take one Huabu Server from "several people sign in and each edits their own Spaces in one shared Workspace" to a service several people can use day to day: each person has their own Workspaces, uses agents in them, and an operator admits people without scripts.

Nothing changes in local mode (`HUABU_IDENTITY_PROVIDER=local`). Desktop and single-owner deployments keep one process-active Workspace, the same routes and the same UI.

## What "ready for several users" means

After both PRs, in Bubble mode:

| Outcome                                                                                                                                                                | PR  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Each admitted person gets a personal Workspace on first sign-in and can create, rename, switch and delete Workspaces they own.                                         | A   |
| Two people work in different Workspaces at the same time. One person switching never moves another person.                                                             | A   |
| Every user configures their own Built-In agent and connects private external agents. Runs have the starter’s permissions; administrators use the same ownership model. | B   |
| Connected credentials and service leases are per person. One person's agent never uses another's GitHub token or service key.                                          | B   |
| A system owner admits members, revokes them and grants Workspace ownership from Settings.                                                                              | B   |
| A session that expires mid-edit is renewed without leaving the page, so unsaved edits survive. Sign-out can end the provider session too.                              | B   |

Out of scope for both: sharing a Workspace or Space between people beyond operator grants, quotas and billing, and Desktop as a multi-user client.

## PR A — Request-scoped Workspaces

### The Workspace a request runs in

Each request runs in exactly one Workspace, resolved once in admission and carried in an `AsyncLocalStorage` context (`modules/workspace/context.ts`, new). `getWorkspaceHandle()`, `getWorkspacePath()`, `getWorkspaceKey()` and `space()` read that context. The rest of the Server's ~145 `space(canvasId)` call sites stay as they are.

How the Workspace is chosen:

- **Local mode:** the process-active Workspace, as today. Switching still changes it for every client, because local mode has one person.
- **Bubble mode:** the principal's _current Workspace_, a per-principal row stored in Huabu (`huabu_identity.current_workspaces`, referencing Bubble's `principalId`, as #228 proposes). Switching changes only that row. It must be a Workspace the principal may enter, else admission falls back to the first one they may enter, or a new personal Workspace.
- **Bubble mode, managed:** when `HUABU_WORKSPACE` locks the Server to one Workspace, everyone works in it. No personal Workspace is created, switching and creating are refused, and `GET /api/workspaces` lists only that Workspace. Which of its Spaces each person sees is still decided Space by Space.

A per-principal preference rather than a Workspace header keeps images, frames, downloads and EventSource working without changes, since they cannot set headers. The cost is that one person's tabs share one current Workspace, which is also the behavior today. Per-tab Workspaces would need the Workspace in every URL and are not planned.

Work that outlives the request (agents, memory updates, Task Runs, preprocessing, World preview reconciliation) captures the Workspace when it starts and runs inside it via `runInWorkspace(handle, fn)`. This replaces today's failure mode, where a switch mid-run either retargets the work or fails it with "inactive workspace".

### Storage

- **SQL namespaces per call, not per connection.** `useWorkspace()` mutates the one Postgres/SQLite connection's namespace today, so concurrent Workspaces would read each other's Spaces. The structured store reads the Workspace id from the context per query, and transactions bind it when they open. The one database-wide write order (`pg_advisory_xact_lock(WRITE_LOCK)`) stays: it also covers name allocation and the Workspace registry. A per-Workspace lock is a later throughput change.
- **Per-Workspace state.** The SQL World id and the Disk directory index are kept per Workspace. The user-skill cache rebuilds whenever the calling Workspace differs, which is correct and costs only a rescan. The Space-create and hierarchy chains stay process-wide: they serialize, which costs throughput, not correctness. Queues that outlive a request (memory passes, World-preview reconciliation, preprocessing) run each item in its enqueuer's scope, because they chain promises from the enqueuing call.
- **Leases.** `acquireWorkspaceOperationLease()` counts per Workspace. It still stops a local-mode switch or a Workspace delete from stranding in-flight work, and no longer refuses a second live Workspace.
- **Maps keyed by Space id alone** (canvas mutex, SSE listeners, memory worker, dir handles, tombstones, Agenetes turn owners) stay as they are. Space ids are random UUIDs or `createId('canvas')`, imports mint new ids, and personal Workspaces start empty. The one way to repeat an id is an administrator adopting a copy of a Disk folder as a second Workspace; that is a known limitation, not guarded.

Not changed: Azure blobs are still prefixed by the Workspace key, which on Disk is the folder path. That predates this work and does not affect several people working at once.

### Roles and capabilities

This replaces #237's model. Huabu checks four capabilities, and the same names apply on a Workspace and on a Space:

| Capability     | Allows                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `huabu.read`   | Seeing and opening the Workspace or Space, every `GET`, search, live streams.                                                              |
| `huabu.write`  | Editing Spaces and creating them. From PR B, also running agents and conversations in them.                                                |
| `huabu.manage` | Renaming and deleting it, changing a Space's parent, granting roles on it. On a Workspace, also its memory, Skills and Workspace settings. |
| `huabu.admin`  | System target only: deployment, Canary, moving the process-wide Workspace, and People administration (PR B).                               |

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
- **Migration from #237.** On first start, `huabu.space.owner` grants are rewritten to qualified targets in the Workspace that holds each Space. `huabu.workspace.owner` grants keep their meaning. An unresolved #237 grant is retained for retry on a later startup: an offline registered Disk Workspace cannot establish that its Space is gone. Unqualified targets grant no access under the new policy. Read failures abort migration without removing the affected grant.
- **Later goal, not in these PRs.** Every request names its Workspace explicitly. Until then a request runs in its caller's current Workspace, and a Space shared from another Workspace is reached by switching to that Workspace.

### Workspaces for members

- **Personal Workspace.** On a member's first admitted request with no readable Workspace, Huabu creates "<name>'s Workspace" and grants them `huabu.workspace.owner` on it, under a per-principal lock so two first requests create one.
- **Management.** `GET /api/workspaces` lists the Workspaces a caller can read. Any member may create one. Activating needs `huabu.read`; rename and delete need `huabu.manage`. On Disk storage, a member's new Workspace goes under the data directory, and any user may also open a Server folder by path as a Workspace of their own, with no further guard: Disk is a debugging setup, not a deployment for strangers. Postgres/Azure and SQLite storage have no Workspace folders and refuse every path. Native folder dialogs, path probing and moving the process-wide Workspace stay with local and administrator callers on localhost.
- **System owner.** A system owner can reach every Workspace through Bubble's system-owner rule, and has a current Workspace like anyone else.

### Agents in PR A

Agents stay owner-only for members, as in #237. Each run now carries its Workspace: the reachback URL becomes `/api/rfs/w/<workspaceId>/<canvasId>`, and RFS runs the call in that Workspace. An owner's agent therefore keeps working when the owner switches away mid-run, instead of failing or reading the other Workspace.

### Web

- Boot no longer activates `registered[0]` in Bubble mode: the Server has already chosen the caller's current Workspace.
- The switcher lists the caller's Workspaces and is enabled for members. Switching posts to `/api/workspaces/:id/activate`, which in Bubble mode sets only the caller's preference.
- The Home folder name and `GET /api/workspace` path are withheld from members, closing a #237 limitation.

### Integration with main (2026-11-02)

- **Moving existing Spaces.** The new hierarchy picker and bring-existing-Space flow reuse `PATCH /api/canvas/:canvasId/parent`. The route retains PR A's `manage` requirement on the moved Space and `write` on its destination. Placement now travels in the request body's optional `position`; the detachment ownership callback remains under the hierarchy lock.
- **Authoritative conversation snapshots.** A stream captures its admitted Workspace and restores it for reads triggered by Canvas publisher callbacks, which can arrive outside the observing request or in another request's scope. Local mode retains the existing process-Workspace change check.
- **Connected devices, profile grouping and file browsing.** PR A retained the legacy owner-only surface. PR B gives every user private devices and Profiles, with the same ownership checks for administrators and members.

### Proof

The Postgres suite runs two principals in two Workspaces concurrently: creates, edits, SSE, search and uploads, with no cross-reads and no transaction aborts. It also checks that a switch in one browser leaves the other unchanged, that an owner's agent keeps its Workspace across the owner's switch, that #237 grants migrate, that a viewer cannot write and an editor cannot rename or delete, that personal Workspaces are created once under concurrent first requests, and that local mode's screenshots stay pixel-identical to `main`.

## PR B — Members use agents, and the service is administrable

### Private agents and settings for every user

Every admitted Bubble user, including a system administrator, has the same personal settings scope. Model configuration, API keys, OAuth, service credentials, Utility Agent selection, change-review preferences and external runtime settings belong to that principal. They have no fallback to another user's settings or the server environment. A new user's default Agent is Built-In Pi; they may choose one of their own external Profiles instead.

Each user obtains a signed device connection credential from the existing connection-command or connection-credentials route. It authenticates only the Agentlet transport. The Gateway records immutable device ownership on first authenticated attachment and refuses another user's attempt to reconnect that identity. Profiles inherit their device's ownership. Listings, direct profile lookups, edits, deletion, CLI discovery, file browsing, placement resolution and conversation controls enforce that ownership without an administrator bypass. Hostname fallback cannot redirect a run onto another owner's device, including during background recovery. There is no sharing mechanism.

Agentlet may continue giving a worker its device transport credential: it does not authorize Huabu HTTP or RFS access. The existing ACP runtime environment hook injects a separate signed `HUABU_RFS_TOKEN` immediately before launch, without persisting it in the workload. It names the device owner, Workspace, Space and conversation. HTTP accepts it only on that Workspace and Space's RFS routes, while its conversation is still an external agent's there on a device its owner owns, and re-resolves the owner's account and current grants on every request and every 30 seconds for open streams. Modified claims, use as a device credential, another Space, a deleted conversation, ordinary settings APIs and disabled owners are refused. Tool execution uses the owner's personal settings and resource access.

Device and reachback credentials carry their owner's credential version. Resetting it, from the user's own Devices settings or by an administrator in People, revokes every connection command and reachback credential that person holds and disconnects their devices and running agents, without rotating the instance key or touching anyone else's devices.

Bubble mode accepts user-owned remote devices and does not supervise an unowned server-local Agentlet. Existing global Profiles are retained for local mode and are not automatically assigned to any Bubble user; Bubble uses a separate user Profile registry. Existing users reconnect devices with their own connection command and configure their own settings. The instance signing key, database, network binding and identity-provider configuration remain server infrastructure. Local mode retains its one implicit user's existing storage and device behavior.

### Integration after #356 merged (2026-11-03)

- Every user sees the existing Devices and Agents, Agent settings, Services and General tabs. Only system administrators additionally see People and deployment readiness.
- OCR never imports deployment legacy files or environment credentials for a member. Pending model OAuth flows, pi-ai runtime Models collections and live OpenAI discovery caches belong to the settings owner. Member pi-ai authentication also excludes ambient environment and file credentials.
- Live Deployment handles retain their namespace in the runtime cache; creation checks it before persistence, and scoped lookups and closes reject another namespace. Members must address a Space even for a new conversation. Artifact inlining checks read access to the source Space. Member model transport excludes deployment environment options, uses public-network connection checks for DNS and redirect hops, and uses SSE to keep streaming on that guarded transport. Providers whose upstream adapters cannot honor a custom transport are unavailable to members.
- Agent invocation rechecks the final binding under the turn lease. External realization and controls authorize the canonical device even when using a persisted binding or a cached handle.
- Session refresh shares one in-flight token exchange, retains the selected provider for logout, and discards a refresh that finishes after sign-out. Popup failures reach the existing sign-in error alert. Recovery uses main's save drain to retry retained sidecar failures while keeping its conflict and restoration guards.

### Grant administration

`/api/people`, and a People tab for system owners, list principals, admit and revoke `member`, and give or remove Workspace roles. Revocation applies on the next request, and to open streams within 30 seconds.

### Session lifecycle

- **Refresh.** Auth0 and Entra sign-in request `offline_access`; generic OIDC uses the configured scopes. The page holds the refresh token in memory only, and renews the session before expiry and on a 401. Timer delays are bounded, transient network failures retain the refresh token, and rejected session adoptions do not broadcast another renewal event.
- **Re-sign-in in a popup.** When renewal is impossible, the sign-in screen opens over the running app and signs in through a popup, then resends the refused saves only after verifying the original principal. Another account forces a reload before cached data or pending edits can be reused. The overlay traps focus, makes the background inert, and restores focus on recovery.
- **Provider logout.** `HUABU_SIGN_OUT_PROVIDER=true` makes sign-out also end the provider session through `end_session_endpoint`. The non-secret provider selection survives page reload in session storage; refresh tokens do not. Logout blocks new session adoptions and waits for existing ones before clearing the cookie.

### Proof

Earlier verification exercised two members using their own Built-In model keys. Current regression coverage additionally uses real Bubble admission, profile storage and Gateway WebSocket connections for two members and two administrators; it verifies private discovery, credentials, direct access refusals, hostname placement, reconnection, scoped callbacks and disabled accounts. Paid external providers are not part of deterministic verification.

## Settled decisions

Confirmed 2026-10-28:

1. **Current Workspace per person, not per tab.** A Workspace in every URL was rejected as a much larger web and API change for a rare need.
2. **Workspace-qualified Space grants,** with an in-place migration of #237's grants, rather than relying on unique Space ids. Space grants stay so that one Space can be shared later. #237's roles are replaced by the model above.
3. **Automatic personal Workspace on first sign-in,** rather than no Workspace until an operator grants one.
4. **Per-person ownership throughout PR B**, including administrators: private model keys, settings, devices, external Profiles and scoped agent callbacks.

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
