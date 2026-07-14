# Managed Agent Teams

> Redesign Agent Teams as a Huabu-managed experience so non-expert users do not need to operate agentlet or manually register an External Agent profile.
>
> Status: **Draft** · Last updated: 2026-07-13 · Tracks: [#253](https://github.com/hai-team/Sediment/issues/253)

---

## 1. Context

The current Agent Team design treats an Agent Team as a special case of an External Agent. Before Huabu can use it, the user must run `agentlet agent-team setup`, ensure the package works outside Huabu, and then register it through an External Agent profile-like form.

User case studies found that this workflow has too many steps and exposes too many technical concepts, especially for non-expert users. This proposal redesigns the boundary so Huabu manages Agent Team discovery, configuration, preparation, and runtime access after the user downloads the package.

## 2. Requirements

### R1 — Minimal work outside Huabu

The user downloads an Agent Team collection root whose member directories follow the structure defined in R2. This is the only required action outside Huabu before adding the collection root.

The first version only consumes collection roots that already exist on a selected agentlet daemon host's filesystem. Downloading, updating, and version-managing those collections remain user-owned operations outside Huabu.

Huabu may bundle selected Agent Teams in the future so those teams can enter the user-visible pool without a separate download, but bundled discovery is not part of the current design scope.

### R2 — Root paths and member discovery

The user adds Agent Team collection roots through the Huabu UI. Each root selects a currently connected agentlet daemon, shown to the user as a machine, and an absolute path in that daemon host's filesystem. The local agentlet daemon is selected by default. A native folder picker is available only for the local daemon; remote daemon roots use direct absolute-path input and are validated by `agent-team/scan`.

Huabu stores the roots as:

```typescript
interface AgentTeamPath {
  machine: string; // Stable agentletId
  path: string; // Absolute path on the daemon host
}

type AgentTeamPaths = AgentTeamPath[];
```

For each root, Agent Team members are discovered at:

```text
<root.path>/
  <agent-name>/
    agentlet.yaml
```

The UI initiates discovery through Agenetes. Agenetes routes the request to the selected agentlet daemon, the daemon scans the corresponding absolute path, and the result returns to Huabu.

An agentlet daemon's `agentletId` is its persistent, configurable machine name. The default machine name is the daemon host's OS hostname, but it must be unique among daemon connections to the same Agenetes host. Registration rejects a conflicting name and requires the operator to configure a different one.

Traversing all configured roots produces `agent-team-members`. A member is identified by `(machine, manifestPath)`:

```typescript
interface AgentTeamMember {
  machine: string;
  manifestPath: string; // Absolute path to agentlet.yaml on the daemon host
  name: string; // Descriptive name read from agentlet.yaml; not an identity
}
```

Results that resolve to the same `(machine, manifestPath)` are merged into one member even when multiple roots discover them. Different members may use the same manifest `name`.

Removing a collection root does not immediately delete member state. If the same `(machine, manifestPath)` remains discoverable through another root, the member is unchanged. If no configured root discovers it, the member, its Configs, and its deployments are retained with `member_missing` status; associated live handles are closed and calls are rejected until the member is discovered again or its deployments are explicitly deleted.

The source package remains in place on the selected daemon host and is always addressed by its original `manifestPath`. Huabu and Agenetes do not copy the source package into managed storage; setup materializes only the deployment's resolved `workingDirPath`.

Each member may have multiple runnable deployment profiles:

```typescript
interface AgentTeamDeployment {
  id: string; // Stable internal identity
  alias: string; // Globally unique, user-editable name
  revision: number; // Changes when placement fields change
  enabled: boolean;
  machine: string;
  manifestPath: string;
  workingDirPath?: string;
  harness: string;
}
```

Configuration is stored separately from deployment profiles and shared by every deployment of the same member:

```typescript
Configs[(machine, manifestPath)] = { key: value, ... };
```

An alias selects one deployment profile for user-facing and API lookup, while the stable deployment ID is used by durable workload bindings. Renaming an alias does not change deployment identity. The same `(machine, manifestPath)` may appear in multiple deployments with different working directories or harnesses, but all of those deployments read the same member-level environment-variable configuration. Secret and non-secret values have different persistence and read-back behavior as defined in R3.

### R3 — Dedicated Settings experience

Settings has a dedicated **Agent Team** tab rather than exposing Agent Teams as a special mode inside the External Agent profile editor.

The tab groups settings by discovered member. Each member has an expandable block or equivalent grouped surface with package information and member-level Configs, followed by the member's deployment aliases.

The member-level Configs table is shared by every deployment whose profile references the same `(machine, manifestPath)`.

Required environment variables are declared structurally in the optional `require.env` field of `agentlet.yaml`. This is a backward-compatible addition to `agentlet-agent-schema-v1`; omitting the field means the member declares no user-configurable environment requirements.

The first version uses an ordered list whose entries contain:

```typescript
interface AgentTeamEnvField {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  default?: string; // Allowed only when secret is false
}
```

Non-secret values are stored in ordinary Agent Team settings and are visible when the UI is reopened. Secret values are stored in Huabu's `SecretStore`; read APIs return only whether each secret is configured, and the UI allows the user to replace or clear it without receiving the existing plaintext.

Each deployment alias provides:

1. An independent enable/disable toggle.
2. A harness dropdown populated from the harnesses declared by the member manifest.
3. An optional `workingDirPath`.

A deployment cannot be enabled while any member-level required environment variable is missing. The member Configs table identifies all missing required values.

Enabling a deployment records the user's enabled intent and starts setup against the selected agentlet daemon after `workingDirPath` has been resolved. Setup emits structured progress events such as `{ phase, message, level }`, allowing the UI to show the current operation and an inspectable setup log.

Deployment readiness is represented separately from enabled intent:

```text
disabled
   │ enable
   ▼
setting_up ── success ──▶ ready
   │
   └──────── failure ───▶ error ── Retry setup ──▶ setting_up
```

A setup failure leaves the deployment enabled with `setupStatus: "error"`. The UI exposes the failure information and a Retry action rather than silently disabling the deployment or retrying indefinitely.

The first version does not resume setup operations across Huabu, Agenetes, daemon, or control-channel restarts. An interrupted operation becomes `error` with a structured `setup_interrupted` reason and requires explicit Retry.

Turning off the enable toggle during `setting_up` immediately records disabled intent and asks the daemon to cancel the active setup operation. A successful cancellation returns the deployment to `disabled`; cancellation failures remain visible rather than allowing an unreported background operation.

Disabling a ready deployment immediately rejects new create and run calls and closes all live handles bound to that deployment. Durable threads are retained and may recover after the deployment is enabled and ready again, provided its placement revision has not changed.

Deleting a deployment closes its live handles and removes its stable deployment ID and alias. Durable threads are retained but can no longer realize; access returns a structured `deployment_missing` error.

The harness dropdown allows the user to select any harness declared by the manifest even when that harness is not currently installed on the selected daemon host. Missing harness executables are reported as explicit errors during deployment creation or runtime rather than blocking selection in Settings.

`workingDirPath` is both the target directory prepared by setup and the process working directory. If omitted, its resolved value is:

```text
<manifest-directory>/workspaces/<harness>/
```

At runtime, environment sources merge in this precedence order:

```text
daemon process env < package .env < Huabu member Configs < Huabu runtime/reachback env
```

Member Config values are delivered only at session spawn. The Agenetes Agent Team module reads current ordinary and secret values through its injected ports, merges them with host runtime/reachback values in memory, and sends the result as ephemeral `SessionSpec.env`. Setup cannot access these values, and they are never copied into the durable `WorkloadSpec`, package `.env`, or prepared workspace.

### R4 — Agenetes Agent Team driver

Agenetes has a standard Agent Team driver built on the ACP driver. Agent Team discovery, deployment management, setup orchestration, readiness, and runtime realization belong to the Agenetes Agent Team control-plane module; Huabu provides the Settings UI and host-specific adapters such as secure credential storage and reachback environment construction.

Agenetes defines the Agent Team registries, state transitions, and persistence ports. Huabu injects implementations for ordinary settings persistence and secure credential storage when mounting Agenetes. The Agenetes module does not import Huabu storage or security code.

### Agentlet control-plane consolidation

Agent Team depends on the shipped [Agenetes Agentlet Gateway Consolidation](../archive/agenetes-agentlet-gateway-consolidation.md).

That prerequisite retires standalone `agentlet-server`, moves the host-side relay into `@agenetes/agentlet-gateway`, makes Agenetes the sole owner of durable workload/session/event state, and leaves agentlet as the remotely deployable execution-plane daemon. This proposal consumes that boundary but does not own its migration.

Setup is not performed inside `AgentDriver.create(...)` or hidden on the first user message. It is an explicit asynchronous consequence of enabling or retrying a deployment, as defined in R3.

Before creating an ACP session, the Agent Team runtime asks the selected agentlet daemon to validate that the prepared workspace is still usable. Validation never performs an implicit setup. If the package or workspace has become invalid, session creation fails, the deployment leaves `ready`, and the user must explicitly run Retry setup.

Agent Team workloads retain their own spec kind and are not lowered to an ACP spec by Huabu. The durable binding uses a stable deployment ID plus the placement revision expected when the thread was bound:

```typescript
interface AgentTeamBinding {
  deploymentId: string;
  expectedDeploymentRevision: number;
}
```

On realization, the Agent Team module resolves the current deployment by ID. If its placement revision differs from the expected revision, realization fails with a structured `deployment_changed` result. Agent Team does not rebind an existing thread to the changed placement; the caller must create a new ThreadIdentity for the current deployment.

Member Configs are intentionally dynamic and are not copied into the durable `WorkloadSpec`. After the revision check, the Agent Team module loads the current Configs through its injected config and secret ports, validates the prepared workspace, and lowers the resolved runtime inputs to the ACP driver. Alias lookup happens at the user/API boundary and resolves to the stable deployment ID before a workload is bound.

The agentlet protocol provides dedicated Agent Team control operations:

| Operation                 | Responsibility                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `agent-team/scan`         | Scan a collection root on the daemon host and return discovered member manifests and UI-relevant metadata. |
| `agent-team/setup`        | Materialize one deployment workspace and emit structured setup progress events.                            |
| `agent-team/setup-cancel` | Cancel the active setup operation for one deployment workspace.                                            |
| `agent-team/validate`     | Validate that a prepared deployment remains usable without mutating or repairing it.                       |

These are formal protocol operations rather than shell-command execution. Agenetes routes each operation to the deployment's explicit `agentletId`.

Setup progress travels as structured JSON-RPC notifications over the daemon control channel. The Agenetes Agent Team service exposes those events as an `AsyncIterable`, and the Huabu adapter projects the same stream to the Settings UI over SSE.

The standard ACP driver is generalized to accept an explicit `agentletId` placement instead of selecting the first connected daemon. Agent Team lowering preserves `deployment.machine` as that ACP placement so workspace validation and session spawn always execute on the same machine.

### R5 — Unified Agent Team API

The system provides an Agent Team service through which a user or an agent can talk to any enabled and ready deployment.

Agenetes owns the host-agnostic service API. Huabu provides a thin `/api/agent-team/*` HTTP/SSE adapter over that service rather than implementing a second Agent Team orchestration layer.

The caller selects a deployment by its current alias and supplies a complete Agenetes `ThreadIdentity` containing `namespace` and `threadId`. The service resolves the alias to the stable deployment ID, constructs the Agent Team `WorkloadSpec`, and then uses standard `Agenetes.create(...)` semantics. Agent Team does not define a separate thread lifecycle, get-or-create rule, or persistence model.

Runs accept the standard Agenetes `AgentSubmission`, including canonical inputs, and stream standard `AgentStreamEvent`s through the resulting `AgentHandle.run(...)`. The Huabu adapter is responsible for rendering a user-side `ChatEnvelope` into canonical inputs before invoking the service; Agenetes never imports the Huabu envelope type.

The first version uses instance-level authentication and permits authenticated Huabu users and agents to call any deployment whose enabled intent is true and whose setup status is `ready`. Deployment-level ACLs are deferred.

Agent-to-agent access uses a generic authenticated HTTP client distributed through Huabu Reachback. The client can send JSON requests and consume SSE streams; it does not add Agent Team-specific `start`, `send`, or `ask` commands. An Agent Team skill teaches agents how to call the standard routes and construct ThreadIdentity and AgentSubmission payloads. The first version does not introduce a separate A2A or MCP protocol for this feature.

The core Huabu invocation routes are:

| Route                                         | Responsibility                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PUT /api/agent-team/threads/:threadId`       | Accept `{ namespace, alias }`, resolve the alias, construct the Agent Team spec, and invoke standard `Agenetes.create(...)`. |
| `POST /api/agent-team/threads/:threadId/runs` | Accept `{ namespace, submission }`, invoke `AgentHandle.run(...)` for the bound thread, and stream standard events over SSE. |

The run route does not accept or re-resolve an alias. Huabu validates the caller-provided namespace against host-owned workspace storage rather than trusting a client-provided storage path.

## 3. Current scope

The first version discovers Agent Teams from roots on connected agentlet daemon hosts. Git URL installation, a marketplace, and bundled Agent Team discovery are deferred.

The first version does not implement a package trust workflow, setup-plan preview, trust persistence, or trust revocation. Adding a collection root and enabling a deployment treats that local package path as trusted and may install dependencies or execute package-defined setup code. This is an explicit first-version security limitation.

This proposal defines the minimum environment-variable declaration and setup-progress requirements but does not yet define upgrades or uninstall behavior.

The first version does not recover an in-flight setup operation or replay a lost terminal setup notification across an agentlet control-channel disconnection. Reliable setup-status reconciliation, for example through a queryable operation status or terminal-event replay, is deferred as a future optimization rather than required by the current Agenetes domain implementation.

The shipped [Agentlet Gateway consolidation](../archive/agenetes-agentlet-gateway-consolidation.md) is a prerequisite foundation for the multi-daemon Agent Team design, not an optional follow-up.

## 4. Related documents

- [`../../agent-teams/README.md`](../../agent-teams/README.md) — current Huabu Agent Team usage.
- [`../architecture/agent-teams-as-extensions.md`](../architecture/agent-teams-as-extensions.md) — current product vision.
- [`../../external/agentlet/spec/agent-team.md`](../../external/agentlet/spec/agent-team.md) — current generic Agent Team package and setup contract.
- [`../architecture/agent-architecture.md`](../architecture/agent-architecture.md) — current External Agent and Agenetes integration.
- [`agenetes-agentlet-gateway-consolidation.md`](../archive/agenetes-agentlet-gateway-consolidation.md) — shipped removal of standalone agentlet-server and consolidation of durable state into Agenetes.
