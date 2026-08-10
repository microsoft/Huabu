# Managed Agent Teams

> Redesign Agent Teams as a Huabu-managed experience and unify every non-internal agent behind one Agenetes Agent Profile model.
>
> Status: **In-Progress** · Last updated: 2026-07-15 · Tracks: [#253](https://github.com/hai-team/Huabu/issues/253)

---

## 1. Context

The original Agent Team design treated an Agent Team as a special case of an External Agent. A user had to run `agentlet agent-team setup`, verify the package outside Huabu, and then manually register it through the External Agent profile editor.

User studies found that workflow too complex, especially for non-expert users. Huabu now bundles the supported templates and manages Agent Team discovery, Configs, preparation, and profile creation.

The first managed implementation added a separate Agent Team deployment registry while preserving the existing ACP profile store. That split prevents ready Agent Team profiles from appearing in Chat and duplicates identity, persistence, selection, and runtime concepts. This proposal replaces both stores with one Agenetes-owned Agent Profile registry.

## 2. Requirements

### R1 — Bundled packages

Huabu ships the repository's `agent-teams/` collection with the desktop application. The Server automatically registers and scans this read-only collection through the locally supervised agentlet after it connects. Users do not download packages or configure collection roots; custom and remote Agent Team collections are outside the current scope.

On upgrade, automatic registration removes roots persisted by earlier custom-collection builds. Existing member metadata, Configs, Profiles, and durable thread snapshots remain stored, but members that are no longer discovered become unavailable and are omitted from Settings.

### R2 — Bundled member discovery

The desktop build copies the fixed collection next to the Server bundle. Source development resolves the checked-in repository collection from the same Server-owned resolver. The collection is always placed on the locally supervised agentlet and remains an internal registry root rather than a user-managed Settings resource.

```typescript
interface AgentTeamRoot {
  agentletId: string;
  path: string;
}
```

Members are discovered at:

```text
<root.path>/
  <agent-name>/
    agentlet.yaml
```

A member is identified by `(agentletId, manifestPath)`. Its manifest `name` is descriptive and is not an identity.

```typescript
interface AgentTeamMember {
  agentletId: string;
  manifestPath: string;
  name: string;
  status: 'active' | 'member-missing';
}
```

Members are discovered from that one collection and retain the existing `(agentletId, manifestPath)` identity so durable Profiles and threads continue using the generic Agent Team runtime contract.

The package remains in the read-only application resources. Huabu and Agenetes do not copy it into the selected workspace; setup materializes only the resolved Profile `workingDirPath`, which may be a Huabu-managed default workspace or a user-selected custom directory.

### R3 — One Agenetes Agent Profile model

Every non-internal agent is represented by one Agenetes-owned Agent Profile. A Profile is a bind-time template, not a running process and not an authorization record for threads that already exist.

```typescript
interface AgentProfileBase {
  id: string;
  alias: string;
  agentletId: string;
  workingDirPath: string;
}

type AgentProfile =
  | (AgentProfileBase & {
      launch: {
        kind: 'agent-team-manifest';
        manifestPath: string;
        harness: string;
      };
      preparation: AgentTeamPreparation;
    })
  | (AgentProfileBase & {
      launch: {
        kind: 'acp-command';
        command: string;
      };
      metadata?: {
        cliId?: string;
      };
    });
```

Member detail enriches a manifest Profile with `setupLog: AgentTeamSetupLogEntry[]`; the core Profile CRD and catalog do not carry diagnostic history.

`agentletId` is placement, `workingDirPath` is the process working directory, and `launch` describes how the ACP command is resolved. `agent-team-manifest` resolves command, requirements, package environment, and harness behavior from `agentlet.yaml`; `acp-command` launches the stored command directly.

Detected CLIs and custom commands are both `acp-command` Profiles. `metadata.cliId` supports editor presentation, icons, and host CLI redetection but does not participate in runtime resolution.

Profile IDs are globally unique and are the only identity used by Chat bindings, HTTP/A2A calls, and durable workloads. Aliases are display-only and may repeat; no runtime API resolves a Profile by alias.

Profile runtime fields are immutable after creation. Changing `agentletId`, `workingDirPath`, or `launch` requires deleting the Profile and creating a new one. Alias and non-runtime metadata remain editable. The immutable runtime identity removes the need for a Profile revision.

Profiles have no Enabled field. An `acp-command` Profile is available for new bindings immediately after creation. An `agent-team-manifest` Profile is available only when its member is active, required Configs are complete, and preparation is `ready`.

Deleting a Profile prevents new bindings but does not stop or invalidate existing threads. Emergency revocation or termination of existing threads is a separate future thread/session operation.

### R4 — Settings and preparation

The backend registry is unified, but Huabu retains two task-oriented Settings tabs:

- **Agent Team** manages bundled members, member Configs, manifest-backed Profiles, default or custom working directories, and preparation.
- **External Agent** manages command-backed Profiles and removes the legacy Agent Team option.

The Agent Team tab initially loads only lightweight bundled-member summaries. The internal bundled root is not editable or rendered. Every member is collapsed by default. A summary contains the member identity and display metadata, discovery status, manifest-backed Profile count, and aggregate preparation status; it does not contain Config fields, Profile records, or setup logs.

Expanding a member loads its detail by `(agentletId, manifestPath)`. The detail contains required environment fields and redacted configuration state, manifest-backed Profiles, preparation state, and setup logs. The web client caches loaded details so collapsing and reopening a member does not repeat the request; registry changes update or invalidate only the affected summary and detail rather than replacing the complete Settings state.

Member Configs are shared by every Profile that references the same `(agentletId, manifestPath)`.

Required environment variables are declared structurally in `agentlet.yaml`:

```typescript
interface AgentTeamEnvField {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  default?: string;
}
```

Non-secret overrides are stored in ordinary Agent Team state. Secret values remain in Huabu's `SecretStore`; read APIs expose only whether each secret is configured.

Manifest-backed preparation uses explicit actions rather than an Enabled toggle:

```text
not-prepared ── Setup ──▶ setting-up ── success ──▶ ready
                              │
                              ├─ failure ──▶ error ── Retry ──▶ setting-up
                              │
                              └─ Cancel ───▶ not-prepared
```

Setup cannot start while required member Configs are missing. `preparation` in the Profile registry is the authoritative durable state. Setup phase diagnostics are persisted separately in a bounded `<encoded-profileId>.setup.jsonl` sibling of `registry.json`; Setup and Retry truncate the previous attempt before new progress is appended. While an expanded member is setting up, Settings polls that member's detail until it reaches a terminal state. An interrupted setup becomes `error` with a structured `setup_interrupted` reason and requires explicit Retry.

Profile deletion is rejected while setup or cancellation is active. Setup is never hidden inside first use or `AgentDriver.create(...)`.

Before a new manifest-backed ACP session starts, the daemon validates that the prepared workspace remains usable. Validation never performs implicit repair. A failed validation returns a structured runtime error and makes the source Profile unavailable for new bindings until the user explicitly retries Setup. A durable thread whose Profile was deleted still reports its own validation or spawn failure without recreating Profile state.

Profile creation defaults to a Huabu-managed, Profile-owned working directory under `<HUABU_DATA_DIR>/agent-team/workspaces/<member>/<harness>/<profile-id>`. The user may instead choose a custom absolute path using the same folder-picker and path-input interaction as a command-backed ACP Profile. Huabu resolves either policy to the concrete `workingDirPath` persisted by Agenetes and never writes into the read-only bundled package.

At runtime, environment sources merge in this precedence order:

```text
daemon process env < package .env < Huabu member Configs < Huabu runtime/reachback env
```

Member Config values are delivered only at session spawn. Secrets are never copied into the durable workload snapshot, package `.env`, or prepared workspace.

### R5 — Runtime binding and realization

Chat preserves its existing top-level distinction between internal and external bindings. Every non-internal selection uses the same Profile binding regardless of launch kind:

```typescript
type AgentBinding =
  | { kind: 'internal' }
  | {
      kind: 'external';
      profileId: string;
      alias: string;
    };
```

When a thread first binds to an external Profile, Agenetes validates that the Profile is currently available and snapshots its runtime fields into the durable WorkloadSpec:

```typescript
interface ExternalProfileSnapshot {
  profileId: string;
  agentletId: string;
  workingDirPath: string;
  launch: AgentProfile['launch'];
}
```

The snapshot prevents Profile deletion or later display metadata changes from silently altering an existing thread. Because runtime fields are immutable, no `expectedRevision` guard is needed.

For `agent-team-manifest`, the workload snapshot retains the member identity and loads current member Configs whenever it spawns a new session. This keeps secrets out of durable workload state while allowing Config updates to take effect on later session spawns.

`@agenetes/agent-team` provides a standard Agent Profile driver/service registered with the core Agenetes instance. It accepts the durable Profile snapshot, resolves either launch kind, loads current manifest Configs and validates prepared workspaces through injected ports when required, and delegates ACP execution to the standard ACP driver. Huabu does not construct `AcpWorkloadSpec` or duplicate Profile lowering.

Both launch kinds preserve explicit `agentletId` placement. Runtime lowering currently sets `SessionSpec.autoRestart = true` for every external workload. Per-Profile restart settings are removed; a future global runtime policy may add configuration, exponential backoff, and circuit breaking.

An `acp-command` Profile has no setup or preflight lifecycle. Its stored fields are validated structurally at creation, and agentlet availability, missing working directories, missing executables, or ACP handshake failures are reported as structured errors from the attempted session spawn.

Huabu Chat and Question Nodes continue using the existing `/api/agent` envelope and thread flow. The route resolves a Profile only when creating the thread's external workload; subsequent runs use the durable snapshot. Agent Team execution must not bypass `ChatEnvelope`, spatial neighbourhood context, reachback environment construction, or standard Agenetes persistence.

### R6 — Catalog and API

Chat consumes one Profile catalog from the unified registry. The selector presents two groups matching Settings:

- **Agent Teams** contains available `agent-team-manifest` Profiles.
- **External Agents** contains all `acp-command` Profiles.

Opening or refreshing the selector must reflect newly prepared, created, or deleted Profiles without requiring an application reload.

The Agenetes Profile service exposes resource-oriented create, read/list, and delete operations plus a restricted patch operation for alias and non-runtime metadata. It does not expose an update operation for `agentletId`, `workingDirPath`, or `launch`; changing runtime identity requires delete followed by create.

Huabu exposes thin validated HTTP adapters over the Agenetes Profile registry and runtime service. Settings adapters may remain split by product surface, but they operate on the same Profile store. Runtime and A2A calls identify Profiles by `profileId`, never alias.

The Agent Team Settings adapter separates overview and detail reads. Its initial overview does not iterate through every member to resolve Config fields or read setup-log files. Member detail fetches and serializes each relevant Profile's log on expansion and is cached by the web client. Profile mutations return the affected core resource instead of rebuilding and returning the complete Agent Team Settings snapshot; the client preserves loaded detail logs across metadata mutations and clears them when Setup or Retry starts.

Runs accept the standard Agenetes `AgentSubmission` and stream standard `AgentStreamEvent`s. Huabu renders `ChatEnvelope` into canonical inputs before invoking the service; Agenetes does not import Huabu envelope types.

Agent-to-agent access continues using authenticated HTTP/SSE through Huabu Reachback. It does not introduce a second Agent Team-specific conversation model.

### R7 — Persistence migration

The unified registry performs a one-time migration from both current stores:

1. Ordinary ACP profiles become `acp-command` Profiles while preserving `profileId`, alias, command, working directory, and optional `cliId`; records created before `cwd` became mandatory preserve their previous inherited-directory behavior by snapshotting the Huabu server working directory. The old per-Profile `autoRestart` value is discarded.
2. Managed Agent Team deployments become `agent-team-manifest` Profiles while preserving their IDs, alias, placement, launch fields, and preparation state. Embedded setup logs migrate idempotently into sibling `<encoded-profileId>.setup.jsonl` files and are removed from the Profile registry. The old enabled intent and revision are discarded.
3. Legacy ACP profiles whose `cliId` is `agent-team` are not auto-migrated because they bypass managed roots, members, Configs, and setup and may duplicate an existing managed Profile. Huabu retains those records long enough to show a clear migration notice instructing the user to create a managed Profile in Agent Team Settings and then delete the legacy record.

Migration is idempotent and must not rewrite an existing unified Profile. Existing ACP thread workload snapshots remain readable until their normal storage migration path replaces the legacy recipe shape.

## 3. Agenetes and agentlet ownership

`@agenetes/agent-team` owns the host-agnostic unified Profile registry, Agent Team roots and members, Config metadata, preparation state, runtime Profile resolution, the standard Agent Profile driver/service, and the first-version file-backed persistence and migration.

`@agenetes/agentlet-host.mountAgenetes(...)` composes the registry with the single Agentlet Gateway and supplies it as the Agent Team control port. Huabu supplies the storage directory, SecretStore adapter, reachback environment, REST projection, and Settings and Chat UI.

The Agentlet Gateway owns live daemon connections and routes every operation to the Profile's explicit `agentletId`. The standard ACP driver owns session creation, resumption, canonical-input flattening, event translation, and durable ACP state.

The agentlet protocol retains dedicated package operations:

| Operation                 | Responsibility                                                              |
| ------------------------- | --------------------------------------------------------------------------- |
| `agent-team/scan`         | Scan a collection root and return discovered manifests and UI metadata.     |
| `agent-team/setup`        | Prepare one manifest-backed Profile workspace and emit structured progress. |
| `agent-team/setup-cancel` | Cancel active preparation for one Profile workspace.                        |
| `agent-team/validate`     | Validate a prepared workspace without mutating or repairing it.             |

Direct `acp-command` Profiles use the existing session spawn protocol and do not call Agent Team setup operations.

## 4. Current scope

The current version consumes only Agent Team packages bundled with Huabu and runs them on the locally supervised agentlet. Custom roots, remote package collections, Git installation, a marketplace, independent package upgrades, and package uninstall behavior are deferred.

Adding a root and explicitly running Setup trusts package-defined setup code. Package trust preview, trust persistence, and revocation are not part of the current version.

Reliable setup reconciliation across a lost control-channel connection remains deferred. An interrupted operation becomes an explicit error instead of being silently retried.

Profile deletion does not revoke existing threads. Global restart policy, crash-loop backoff, circuit breaking, and explicit thread/session revocation are future runtime capabilities.

## 5. Implementation progress

### ✅ Foundation shipped

- Multi-daemon Agentlet Gateway placement and the locally supervised daemon.
- Agent Team root discovery, member reconciliation, Configs, SecretStore integration, setup orchestration, persisted progress, and Settings UI.
- Structured CLI requirements, shared npm tool installation, bundled manifests, and package documentation.
- Desktop packaging and automatic local registration of the fixed bundled collection; Settings no longer exposes collection-root mutations.

### ✅ Unified Profile registry

- Replace Agent Team deployment records and the host ACP profile store with the `AgentProfile` union.
- Expose Agenetes create, read/list, delete, and alias/metadata patch operations and change subscriptions for the unified Profile resource.
- Add idempotent migration and legacy Agent Team profile notice.
- Remove enabled intent, revision, per-Profile auto-restart, runtime-field editing, alias uniqueness, and the legacy Agent Team option from External Agent Settings.
- Replace the full Agent Team Settings snapshot with lightweight member overview reads, cached on-demand member detail, and affected-resource mutation responses.
- Separate bounded setup diagnostics from the Profile CRD into per-Profile JSONL files loaded only by member detail.

### ✅ Runtime and Chat integration

- Register the standard Agent Profile driver/service with core Agenetes and remove Huabu-owned `AcpWorkloadSpec` construction.
- Add durable external workload snapshots for both launch kinds.
- Lower manifest-backed snapshots through injected Config resolution and validation ports into the ACP driver.
- Project the unified Profile catalog into the two Chat selector groups.
- Route Chat and Question Node external bindings by `profileId`.
- Add focused migration, registry, runtime, API, and selector coverage; Question Nodes reuse the same `/api/agent` binding path.

## 6. Related documents

- [`../../agent-teams/README.md`](../../agent-teams/README.md) — current Huabu Agent Team usage and package authoring.
- [`../architecture/agent-teams-as-extensions.md`](../architecture/agent-teams-as-extensions.md) — current product vision and shipped control-plane boundaries.
- [`../../external/agentlet/spec/agent-team.md`](../../external/agentlet/spec/agent-team.md) — generic Agent Team package and setup contract.
- [`../architecture/agent-architecture.md`](../architecture/agent-architecture.md) — current built-in and ACP agent runtime.
- [`agenetes-agentlet-gateway-consolidation.md`](./agenetes-agentlet-gateway-consolidation.md) — shipped Gateway ownership and placement foundation.
