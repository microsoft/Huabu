# Managed ACP Harness

> Record the deferred managed-harness direction and define the nearer-term Profile lifecycle that compiles a scanned Agent Team manifest into a durable external-agent `WorkloadSpec`.
>
> Status: **Draft** · Last updated: 2026-07-20 · Tracks: [#321](https://github.com/hai-team/Huabu/issues/321) · Follows: [#253](https://github.com/hai-team/Huabu/issues/253), [#334](https://github.com/hai-team/Huabu/issues/334)

---

## 1. Context

Agent Team setup currently prepares prompts and skills inside a Profile's `workingDirPath` because supported harnesses discover configuration from conventional files beneath their process working directory. This coupling remains accepted for the current implementation; removing it requires harness-specific integration and is deferred.

Resource management, downloading, caching, receipts, and reuse are now the highest-priority part of #321 because installation and setup latency depend on them. Resource acquisition remains a distinct architectural boundary, but Profile setup should consume reusable Resource Manager outputs instead of repeatedly downloading or installing equivalent resources.

Issue #334 established the lower control-plane boundary used here: `WorkloadSpec` is an opaque envelope whose `kind` directly selects a driver from a static DriverMap; each driver defines and validates its own spec and durable-state schemas. That refactor stands independently and should land before the remaining #321 optimizations.

## 2. Current scope decision

The current implementation keeps Agent Team Profiles on the generic `external` ACP driver and keeps setup materialization inside `workingDirPath`. File-free setup, isolated harness configuration roots, `CompiledAcpLaunch`, and direct harness-specific driver kinds such as `external-copilot` are backlog work rather than requirements for the next #321 increment.

The nearer-term optimization is to make the existing Agent Team flow deterministic: parse a manifest during scan, bind a specific scanned revision into a Profile, run explicit setup, persist the resulting generic external-driver spec template, and compile the final durable `WorkloadSpec` from that template when the caller supplies thread identity.

Launch must not rediscover or reinterpret the source manifest. A changed manifest becomes visible only through an explicit rescan and invalidates affected prepared Profiles rather than silently changing an existing launch.

## 3. Profile lifecycle and workload compilation

The intended lifecycle is:

```text
scanned normalized manifest revision
              │
              ▼
user Config indexed by (agentletId, manifestPath)
              │
              ▼
user-created Profile indexed by profileId
  + agentletId + manifest revision + harness + workingDirPath
              │
              ▼
explicit setup indexed by profileId
  + reusable Resource Manager outputs
  + on-demand manifest-derived setup behavior
              │
              ▼
prepared generic external-driver spec template
              │
              ▼
profileId + threadId + namespace + initialPreamble + runtime context
              │
              ▼
durable WorkloadSpec
              │
              ▼
Agenetes.create(...) → DriverMap["external"]
```

Scanning persists a validated normalized manifest snapshot and digest, not only the current UI summary. "Read once" means once per explicit scan or rescan revision: setup consumes the persisted snapshot, and spawn never rereads `agentlet.yaml`.

Config remains indexed by `(agentletId, manifestPath)` because it belongs to the discovered Agent Team definition. Setup-time Config changes invalidate prepared Profiles based on that definition. Runtime Config, especially secrets, is resolved through runtime ports and does not enter durable driver specs.

Profile creation fixes the selected agentlet, manifest revision, harness, and working directory under a `profileId`. Setup remains explicit and may continue writing the legacy harness files into `workingDirPath`, but it consumes reusable resources and produces a versioned, non-secret external-driver spec template containing the resolved command, working directory, launch inputs, and resource receipts required for later recovery.

The Profile management control plane owns `compileWorkloadSpec(...)`. The host supplies `profileId`, `threadId`, `namespace`, `workloadType`, `initialPreamble`, and runtime context; the compiler validates that the Profile is ready and not stale, combines those caller-owned values with the prepared template, and returns a complete `WorkloadSpec`.

This compiler belongs beside Profile management rather than inside the generic Agenetes runtime kernel. `Agenetes.create(...)` must continue to receive the complete durable boundary so static driver routing, schema validation, recovery, fork, and operation after Profile deletion do not depend on mutable Profile state.

## 4. Goals

1. Define one portable ACP launch baseline that works for an arbitrary ACP command without harness knowledge.
2. Preserve the #334 `WorkloadSpec` and static DriverMap boundary independently from the deferred managed-harness design.
3. Make manifest scanning the only source-manifest read and persist the normalized revision consumed by setup.
4. Make Profile setup produce a versioned generic external-driver spec template instead of deferring manifest resolution until spawn.
5. Centralize Profile-to-`WorkloadSpec` compilation in the Profile management control plane rather than constructing driver specs ad hoc in `runAcpAgent(...)`.
6. Reuse Resource Manager outputs across Profile setup operations while retaining explicit setup and current working-directory materialization.
7. Keep secrets out of manifests, setup receipts, driver spec templates, and durable `WorkloadSpec`.

## 5. Non-goals

This proposal does not define the Resource Manager's resource identity, downloader, cache, trust, upgrade, receipt, or garbage-collection contracts. Those contracts are a prerequisite workstream with higher implementation priority.

This proposal does not require every ACP harness to support native system prompts, external skill roots, plugins, or MCP configuration.

This proposal does not make `initialPreamble` equivalent to an ACP or model-native system-role message.

The current increment does not introduce harness-specific drivers, direct managed-harness kinds, `CompiledAcpLaunch`, or native harness configuration compilation.

The current increment does not make setup file-free or move prepared harness configuration outside `workingDirPath`.

## 6. Terminology

| Term                          | Meaning                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working directory             | The user-selected project directory supplied as the ACP session `cwd`; the agent inspects and modifies this project.                                                 |
| Logical harness configuration | Harness-independent Agent Team declarations such as instructions, skills, MCP servers, plugins, tools, and environment requirements.                                 |
| Prepared resource             | A validated reusable resource acquired during explicit setup and stored outside the project working directory.                                                       |
| Compiled configuration        | Harness-specific launch material derived from logical configuration and prepared resources, stored or referenced outside the project working directory.              |
| Standard ACP driver           | The reusable implementation that owns ACP session lifecycle, recovery, input lowering, event translation, control messages, and durable ACP state.                   |
| Managed harness driver        | A driver selected directly by a harness-specific `WorkloadSpec.kind`; it validates its own spec/state and compiles logical configuration into a concrete ACP launch. |
| Generic ACP fallback          | Launching an arbitrary ACP command with the standard minimum contract and no managed harness preparation.                                                            |

## 7. Standard ACP launch baseline

The standard ACP driver must support a launch that is independent of any known harness:

```typescript
interface StandardAcpLaunch {
  command: string;
  cwd: string;
  agentletId: string;
}
```

`command` selects the ACP server process, `cwd` remains the project working directory, and `agentletId` provides explicit execution-node placement. Process availability, missing directories, ACP handshake failures, and unsupported protocol capabilities are reported as structured launch/runtime errors.

The generic baseline has no setup, preparation, validation, download, installation, or implicit repair operation. It must not write configuration into `cwd`. A command-backed Profile becomes eligible for launch immediately after structural validation.

`initialPreamble` is not part of `StandardAcpLaunch` because it belongs to the shared `AgentSpec` shape embedded in each agent driver's opaque payload:

```typescript
interface AgentSpec {
  initialPreamble?: readonly string[];
}

interface WorkloadSpec {
  kind: string;
  workloadType: 'Job' | 'Deployment';
  namespace: Namespace;
  threadId: string;
  spec: unknown;
}
```

The concrete `spec` selected by `kind` extends `AgentSpec` and contains the ACP launch inputs. The preamble remains independent from host request rendering while its realization and delivery state stay driver-owned.

## 8. Durable `initialPreamble` semantics

### 8.1 Contract

`initialPreamble` is an ordered list of host-authored instructions attached to a workload when its durable `WorkloadSpec` is created. It is immutable for that durable workload realization.

The standard portable realization joins the entries with paragraph boundaries and prepends the result to the first ordinary user prompt accepted by a newly created ACP session.

An ACP command submission does not consume the pending preamble. The next ordinary submission remains responsible for realizing it.

Delivery becomes durable only after the prompt carrying the preamble succeeds. A failed prompt leaves the preamble pending so a later ordinary submission can retry it.

`initialPreambleDelivered` is persisted independently from the ACP `sessionId`. Creating or persisting a session does not itself prove that the preamble was realized.

Recovery and fork must use the durable delivery state supplied by Agenetes rather than infer delivery from message count, `sessionId`, or host rendering state.

### 8.2 Semantic limits

The portable realization is instruction-like content in the first ACP prompt. It is not guaranteed to have system-message priority, to be hidden from the harness transcript, or to be protected from later user instructions.

A managed harness driver may realize the same logical preamble through a native system-prompt or agent-definition mechanism. It must not both perform native realization and allow the standard prompt-prefix fallback to deliver the same content again.

The exact acknowledgement contract for native realization remains open. Candidate approaches include returning an explicit preamble realization mode from compilation or reporting successful realization from session bootstrap.

### 8.3 Host rendering consequence

Host request rendering should render only the current submission. It should not inspect `isFirstMessage`, prepend system instructions, or decide whether recovery needs another preamble.

This keeps first-message behavior in the durable driver lifecycle and allows the same renderer to be used for fresh runs, resumed sessions, recovered sessions, and forks.

## 9. Backlog: provisional compiled launch boundary

The following shape records the current design direction but is not yet a final API:

```typescript
interface CompiledAcpLaunch {
  command: string;
  cwd: string;
  agentletId: string;
  env?: Record<string, string>;
  sessionInit?: {
    mcpServers?: readonly AcpMcpServer[];
    additionalDirectories?: readonly string[];
    meta?: JsonObject;
  };
}
```

The standard fields remain concrete process/session inputs. `sessionInit` represents ACP-native session initialization data rather than files to materialize in `cwd`.

The current standard ACP client supplies empty `mcpServers` during session creation, and the agentlet bootstrap creates the native ACP session before the Agenetes handle attaches. Supporting compiled session configuration therefore requires the complete spawn/bootstrap path to carry the same durable session-init input; changing only `AcpAgentClient.newSession(...)` would not be sufficient.

The final contract may need additional fields for native preamble realization, executable/tool paths, isolated config roots, plugin directories, permission policy, and launch diagnostics. These fields should be added only after the managed harness mechanisms are verified.

## 10. Backlog: managed harness model

Managed support means more than recognizing a command name. A managed harness has its own directly routed driver with versioned spec/state schemas; that driver must compile the declared Agent Team capabilities without modifying the project working directory and validate that the resulting launch is usable.

The initial planned managed harnesses are:

| Harness            | Confirmed integration surfaces                                                                                    | Design work still required                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Copilot CLI        | External plugin directories, additional MCP configuration, custom agents, skills, and ACP launch flags            | Define the isolated plugin/agent bundle, instruction precedence, project-instruction policy, and supported CLI version range.                                |
| `claude-agent-acp` | ACP client MCP servers, additional directories, `_meta.systemPrompt`, and Claude SDK option forwarding            | Define which settings and skill/plugin sources may come from an external compiled bundle and how native preamble delivery is acknowledged.                   |
| `codex-acp`        | ACP client MCP servers, `CODEX_CONFIG`, Codex session configuration, and configured skills exposed by `codex-acp` | Verify external skill/config-root isolation, instruction mapping, process-level environment isolation, and supported `codex-acp`/Codex version combinations. |

A harness is fully managed only when every capability declared by the Agent Team can be supplied without project-directory configuration residue. Missing integration capabilities must produce an explicit unsupported-capability result; they must not silently fall back to writing files into `cwd`.

An unknown harness or an unsupported version may still be launched through a generic command-backed ACP Profile, but that fallback provides only the standard ACP baseline and portable `initialPreamble`.

## 11. Backlog: managed harness layering

The current architectural direction is:

```text
Agent Profile + logical Agent Team configuration
                 │
                 ▼
  kind-specific managed harness driver
       │ validate + compile
       ▼
    CompiledAcpLaunch
                 │
                 ▼
       Shared ACP runtime core
                 │
                 ▼
     agentlet spawn + ACP bootstrap
```

The mounted DriverMap performs direct dispatch: `external` selects the generic ACP driver, while expanded kinds select independent managed harness drivers. No adapter map, router key, driver name indirection, or runtime fallback participates in this choice.

Each managed harness driver owns its harness-specific spec/state schemas and configuration compilation. Shared ACP code owns behavior that remains protocol-generic: session creation and load, recovery fallback, canonical input lowering, stream translation, controls, cancellation, metadata, and durable state reporting.

The execution node must participate because command availability, installed harness version, local paths, platform behavior, and compiled resource locations are node-local facts. It remains undecided which compilation steps happen in the managed driver before spawn and which require a paired execution-node component.

## 12. Backlog: file-free configuration semantics

`workingDirPath` continues to mean only the project directory used as process and ACP session `cwd`.

A Profile should not expose a generic `configFolder` whose contents or ownership vary by harness. Logical configuration should reference typed capabilities and prepared resources; the selected managed driver decides whether those become ACP initialization fields, CLI arguments, environment variables, plugin roots, or externally stored files.

Compiled configuration is implementation-owned launch material. It must live outside the project working directory, be isolated by content or Profile identity, and be safe for concurrent use by multiple sessions.

Launching a managed harness must not download, install, repair, add, modify, or delete Agent Team configuration in the project. Launch may read previously prepared resources and may create session-scoped state in an implementation-owned runtime directory.

Project-owned configuration already present in `workingDirPath` is a separate policy question. Each managed driver must define whether it is inherited, disabled, or composed with Agent Team configuration, including deterministic precedence and collision behavior.

## 13. Future file-free invariants

1. `workingDirPath` always identifies the user project, never a prepared Agent Team workspace.
2. Two Agent Teams targeting the same `workingDirPath` cannot overwrite or observe each other's compiled configuration unless they intentionally reference the same immutable prepared resource.
3. Generic ACP launch performs no setup and writes no managed configuration into `cwd`.
4. Managed launch performs no network access, download, installation, or implicit repair.
5. The shared ACP runtime core contains no harness-name conditionals.
6. Harness-specific configuration does not alter ACP recovery, event, control, or durable-state semantics.
7. A native preamble realization and the portable first-prompt fallback are mutually exclusive for one live session.
8. Resume, recovery, and fork use the same durable compiled launch inputs or an explicitly versioned recompilation policy; they do not rediscover ambient configuration silently.
9. Unsupported harness capabilities fail explicitly before or during launch without leaving project-directory residue.
10. Secrets are delivered at spawn/session initialization and are not copied into durable `WorkloadSpec`, compiled configuration files, or project files.

## 14. Backlog managed-driver design questions

The following questions remain deliberately open for the next design step:

1. What normalized logical input should each managed driver compile: an Agent Profile snapshot, a capability manifest, prepared resource references, or a smaller launch request?
2. Which parts of `CompiledAcpLaunch` must remain durable in the driver spec, and which may be resolved from immutable resource identities on the execution node?
3. How are harness version and compiled-config schema version recorded alongside the driver's own `driverSchemaVersion`?
4. How does a managed driver declare support for native system prompts, external skills, client MCP, plugin roots, additional directories, and project-config suppression?
5. How does native preamble realization update that driver's durable delivery state without starting a model turn?
6. Are compiled configuration bundles shared by content digest, isolated per Profile, or assembled per session from shared immutable resources?
7. Which session-scoped files are permitted outside `cwd`, and who removes them after failed launch or session close?
8. How does validation distinguish unsupported driver capability, missing prepared resource, incompatible harness version, and ordinary process/ACP failure?
9. How should project-owned harness configuration compose with managed Agent Team configuration?
10. Does `CompiledAcpLaunch.command` remain a shell command string, or should managed drivers produce an executable plus argument vector while the generic fallback preserves command strings?

## 15. Revised implementation sequence

1. Land #334 independently so the opaque `WorkloadSpec`, static DriverMap, driver-owned schemas, and durable `initialPreamble` semantics become the stable lower boundary.
2. Define and implement the Resource Manager contracts needed to avoid repeated downloads and installations during Profile setup.
3. Extend Agent Team scan results and registry persistence with a normalized manifest snapshot and digest.
4. Bind Profiles to a scanned manifest revision and mark preparation stale when that revision or setup-time Config changes.
5. Make setup consume the persisted manifest revision and Resource Manager outputs, then return a versioned generic external-driver spec template and resource receipts.
6. Add Profile management `compileWorkloadSpec(...)` and reduce `runAcpAgent(...)` to supplying caller-owned context.
7. Send direct command/cwd/env launch inputs to agentlet for newly prepared Profiles; retain spawn-time manifest resolution only as an explicitly bounded compatibility path for old persisted workloads.
8. Defer harness-specific drivers, `CompiledAcpLaunch`, and file-free setup until resource reuse and the deterministic generic Profile flow are established.

## 16. Related documents and code

| File                                                                                                                                   | Relevance                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`managed-agent-teams.md`](./managed-agent-teams.md)                                                                                   | Current managed Profile, Config, preparation, and runtime design.               |
| [`../architecture/agent-teams-as-extensions.md`](../architecture/agent-teams-as-extensions.md)                                         | Product and ownership model for Agent Teams as extensions.                      |
| [`../../external/agenetes/packages/protocol/src/workload.ts`](../../external/agenetes/packages/protocol/src/workload.ts)               | Opaque workload envelope and shared durable `AgentSpec.initialPreamble` schema. |
| [`../../external/agenetes/packages/protocol/src/agent-state.ts`](../../external/agenetes/packages/protocol/src/agent-state.ts)         | Generic durable `driverState + metadata` envelope.                              |
| [`../../external/agenetes/packages/acp-driver/src/handle.ts`](../../external/agenetes/packages/acp-driver/src/handle.ts)               | Current portable first-ordinary-prompt realization.                             |
| [`../../external/agenetes/packages/runtime/src/driver.ts`](../../external/agenetes/packages/runtime/src/driver.ts)                     | Static DriverMap and driver-local spec/state definition boundary.               |
| [`../../external/agentlet/packages/agent-team/src/resolve/index.ts`](../../external/agentlet/packages/agent-team/src/resolve/index.ts) | Current manifest-to-command/cwd/env resolution.                                 |
| [`../../external/agentlet/spec/agent-team.md`](../../external/agentlet/spec/agent-team.md)                                             | Current prepared-workspace and harness configuration contract.                  |
