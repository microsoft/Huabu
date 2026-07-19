# Managed ACP Harness

> Define the standard ACP launch baseline, promote durable `initialPreamble` to the shared agent-spec semantic, and separate managed harness configuration from the project working directory.
>
> Status: **In-Progress** · Last updated: 2026-07-18 · Tracks: [#321](https://github.com/hai-team/Sediment/issues/321) · Follows: [#253](https://github.com/hai-team/Sediment/issues/253), [#334](https://github.com/hai-team/Sediment/issues/334)

---

## 1. Context

Agent Team setup currently prepares prompts and skills inside a Profile's `workingDirPath` because supported harnesses discover configuration from conventional files beneath their process working directory. This couples the project an agent should inspect and modify with the instructions and capabilities that define the agent.

Issue #321 separates this problem from resource acquisition. Resource management, downloading, caching, receipts, and garbage collection will be designed separately. This proposal focuses on ACP launch semantics and on making managed harness configuration available without writing it into the selected project directory.

Issue #334 established the lower control-plane boundary used here: `WorkloadSpec` is an opaque envelope whose `kind` directly selects a driver from a static DriverMap; each driver defines and validates its own spec and durable-state schemas. The shared `AgentSpec` carries `initialPreamble`, while the ACP driver's state persists `initialPreambleDelivered` independently from its session id.

## 2. Agreed direction

The following decisions are the current design baseline:

1. Durable `initialPreamble` is a shared `AgentSpec` semantic inside each agent driver's opaque `WorkloadSpec.spec` payload rather than per-turn rendered input.
2. A generic ACP workload can always fall back to the minimal `{ command, cwd, agentletId }` launch configuration, optionally with `initialPreamble`.
3. Generic command-backed ACP Profiles have no setup or preparation lifecycle.
4. `CompiledAcpLaunch` is the boundary between logical Profile configuration and a concrete ACP process/session launch, although its exact fields remain provisional.
5. Copilot CLI, `claude-agent-acp`, and `codex-acp` are the initial planned managed harnesses.
6. Each managed harness receives an independent driver route such as `external-copilot`, `external-claude-agent-acp`, or `external-codex-acp`; `WorkloadSpec.kind` is the only routing key.
7. Managed harness drivers share ACP-generic session lifecycle, recovery, event translation, controls, and transport implementation instead of duplicating that lower-level core.
8. There is no central Harness Adapter registry or host router. Harness-specific compilation belongs to the selected driver and its package-level collaborators.

## 3. Goals

1. Define one portable ACP launch baseline that works for an arbitrary ACP command without harness knowledge.
2. Give `initialPreamble` durable, driver-owned first-message semantics so host rendering no longer branches on `isFirstMessage`.
3. Allow managed harnesses to use native instructions, skills, plugins, MCP servers, and tools without materializing Agent Team configuration inside the project working directory.
4. Preserve one shared ACP implementation for runtime lifecycle and protocol behavior beneath independently routed harness drivers.
5. Make the difference between fully managed, partially managed, and generic fallback harnesses explicit rather than silently degrading configuration.
6. Keep compiled configuration isolated between Agent Teams and sessions that target the same project.

## 4. Non-goals

This proposal does not define the Resource Manager, downloader, cache receipt, upgrade, trust, or garbage-collection design from issue #321.

This proposal does not require every ACP harness to support native system prompts, external skill roots, plugins, or MCP configuration.

This proposal does not make `initialPreamble` equivalent to an ACP or model-native system-role message.

This proposal does not yet finalize each managed driver's compiled launch schema or how its compilation is divided between the control plane and execution node.

This proposal does not preserve the current prepared-workspace layout as a compatibility requirement. Migration of existing Profiles and prepared workspaces will be designed after the target contract is stable.

## 5. Terminology

| Term                          | Meaning                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working directory             | The user-selected project directory supplied as the ACP session `cwd`; the agent inspects and modifies this project.                                                 |
| Logical harness configuration | Harness-independent Agent Team declarations such as instructions, skills, MCP servers, plugins, tools, and environment requirements.                                 |
| Prepared resource             | A validated reusable resource acquired during explicit setup and stored outside the project working directory.                                                       |
| Compiled configuration        | Harness-specific launch material derived from logical configuration and prepared resources, stored or referenced outside the project working directory.              |
| Standard ACP driver           | The reusable implementation that owns ACP session lifecycle, recovery, input lowering, event translation, control messages, and durable ACP state.                   |
| Managed harness driver        | A driver selected directly by a harness-specific `WorkloadSpec.kind`; it validates its own spec/state and compiles logical configuration into a concrete ACP launch. |
| Generic ACP fallback          | Launching an arbitrary ACP command with the standard minimum contract and no managed harness preparation.                                                            |

## 6. Standard ACP launch baseline

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

## 7. Durable `initialPreamble` semantics

### 7.1 Contract

`initialPreamble` is an ordered list of host-authored instructions attached to a workload when its durable `WorkloadSpec` is created. It is immutable for that durable workload realization.

The standard portable realization joins the entries with paragraph boundaries and prepends the result to the first ordinary user prompt accepted by a newly created ACP session.

An ACP command submission does not consume the pending preamble. The next ordinary submission remains responsible for realizing it.

Delivery becomes durable only after the prompt carrying the preamble succeeds. A failed prompt leaves the preamble pending so a later ordinary submission can retry it.

`initialPreambleDelivered` is persisted independently from the ACP `sessionId`. Creating or persisting a session does not itself prove that the preamble was realized.

Recovery and fork must use the durable delivery state supplied by Agenetes rather than infer delivery from message count, `sessionId`, or host rendering state.

### 7.2 Semantic limits

The portable realization is instruction-like content in the first ACP prompt. It is not guaranteed to have system-message priority, to be hidden from the harness transcript, or to be protected from later user instructions.

A managed harness driver may realize the same logical preamble through a native system-prompt or agent-definition mechanism. It must not both perform native realization and allow the standard prompt-prefix fallback to deliver the same content again.

The exact acknowledgement contract for native realization remains open. Candidate approaches include returning an explicit preamble realization mode from compilation or reporting successful realization from session bootstrap.

### 7.3 Host rendering consequence

Host request rendering should render only the current submission. It should not inspect `isFirstMessage`, prepend system instructions, or decide whether recovery needs another preamble.

This keeps first-message behavior in the durable driver lifecycle and allows the same renderer to be used for fresh runs, resumed sessions, recovered sessions, and forks.

## 8. Provisional compiled launch boundary

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

## 9. Managed harness model

Managed support means more than recognizing a command name. A managed harness has its own directly routed driver with versioned spec/state schemas; that driver must compile the declared Agent Team capabilities without modifying the project working directory and validate that the resulting launch is usable.

The initial planned managed harnesses are:

| Harness            | Confirmed integration surfaces                                                                                    | Design work still required                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Copilot CLI        | External plugin directories, additional MCP configuration, custom agents, skills, and ACP launch flags            | Define the isolated plugin/agent bundle, instruction precedence, project-instruction policy, and supported CLI version range.                                |
| `claude-agent-acp` | ACP client MCP servers, additional directories, `_meta.systemPrompt`, and Claude SDK option forwarding            | Define which settings and skill/plugin sources may come from an external compiled bundle and how native preamble delivery is acknowledged.                   |
| `codex-acp`        | ACP client MCP servers, `CODEX_CONFIG`, Codex session configuration, and configured skills exposed by `codex-acp` | Verify external skill/config-root isolation, instruction mapping, process-level environment isolation, and supported `codex-acp`/Codex version combinations. |

A harness is fully managed only when every capability declared by the Agent Team can be supplied without project-directory configuration residue. Missing integration capabilities must produce an explicit unsupported-capability result; they must not silently fall back to writing files into `cwd`.

An unknown harness or an unsupported version may still be launched through a generic command-backed ACP Profile, but that fallback provides only the standard ACP baseline and portable `initialPreamble`.

## 10. Proposed layering

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

## 11. Configuration semantics

`workingDirPath` continues to mean only the project directory used as process and ACP session `cwd`.

A Profile should not expose a generic `configFolder` whose contents or ownership vary by harness. Logical configuration should reference typed capabilities and prepared resources; the selected managed driver decides whether those become ACP initialization fields, CLI arguments, environment variables, plugin roots, or externally stored files.

Compiled configuration is implementation-owned launch material. It must live outside the project working directory, be isolated by content or Profile identity, and be safe for concurrent use by multiple sessions.

Launching a managed harness must not download, install, repair, add, modify, or delete Agent Team configuration in the project. Launch may read previously prepared resources and may create session-scoped state in an implementation-owned runtime directory.

Project-owned configuration already present in `workingDirPath` is a separate policy question. Each managed driver must define whether it is inherited, disabled, or composed with Agent Team configuration, including deterministic precedence and collision behavior.

## 12. Required invariants

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

## 13. Remaining managed-driver design questions

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

## 14. Proposed design sequence

1. Specify and test the complete durable `initialPreamble` contract across fresh create, command-first sessions, failure, resume, recovery fallback, and fork.
2. Remove first-message instruction branching from host request rendering after the durable contract covers the existing behavior.
3. Define the normalized logical capability input and managed-driver capability model.
4. Verify the exact configuration and isolation mechanisms of the supported Copilot CLI, `claude-agent-acp`, and `codex-acp` versions.
5. Finalize `CompiledAcpLaunch` and carry its session-init fields through Agent Profile lowering, agentlet spawn, ACP bootstrap, resume, and recovery.
6. Implement one managed harness end to end, extract only the ACP-generic runtime core it proves, and reuse that core in the remaining independently routed drivers.
7. Replace prepared workspaces under `workingDirPath` with implementation-owned compiled configuration and add migration behavior.

## 15. Related documents and code

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
