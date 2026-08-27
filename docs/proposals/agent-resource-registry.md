# Machine-Aware Agent Resource Registry

Status: Draft

Last updated: 2026-08-27

Tracking issue: [#120](https://github.com/microsoft/Huabu/issues/120)

Initial child implementation: [#110](https://github.com/microsoft/Huabu/issues/110)

## 1. Context

Huabu exposes agent-facing resources through several independent mechanisms: RFS Skills and direct Space operations, built-in agent tools, Agenetes Agent Profiles, Agent Team Config, Agentlet-provided process environments, distributed scripts, Canvas artifacts, and user-authored instructions.

External agents currently have no single catalogue that answers which resources exist, which apply to their current machine and conversation, how to access them, and which prerequisites are missing. Adding one bespoke integration per capability would duplicate discovery, authorization, secret handling, and versioning.

The Agent Resource Registry provides one machine-aware catalogue over those existing sources. An agent receives a compact projection first and loads or invokes an individual resource only when needed.

The registry is conceptually similar to an installed-program or device registry: it records stable logical resources and their applicable access locations, but it does not become the storage location for every resource body or secret.

## 2. Goals

1. Give built-in and external agents one normalized catalogue of Skills, hosted tools, Agent Profiles, scripts, artifacts, executables, environment declarations, instructions, and composite Connectors.
2. Project only resources applicable to the current Machine, Profile, Canvas, thread, and authorization context.
3. Separate stable logical resource identity from machine-specific paths, caches, versions, and availability.
4. Let agents discover compact summaries and fetch detailed instructions or schemas on demand.
5. Preserve existing sources of truth rather than copying Profile, Skill, secret, or artifact state into another authoritative database.
6. Keep secrets server-side and expose only bounded readiness and injection semantics.
7. Support rapid schema evolution through explicit versions on every durable or wire-level contract.
8. Let the first version accept user-declared machine placements without requiring a new Agentlet resource-probe protocol.

## 3. Non-goals

- Automatically maintaining desired software state on every machine.
- Continuously reinstalling a resource after a user removes it.
- Adding a generic remote-command or arbitrary probe API to Agentlet.
- Treating an agent's claim that installation succeeded as trusted machine state.
- Replacing RFS, MCP, Agenetes Profiles, Agent Team manifests, package managers, or the SecretStore.
- Exposing secret values, provider credentials, privileged host configuration, or unrestricted environment inheritance.
- Standardizing the final field-level schemas before the HackMD proof of concept validates the model.

## 4. Ownership

Huabu Server owns the registry's product semantics, aggregation, authorization filtering, user annotations, and final projection.

RFS is the primary discovery and access adapter for external agents. Built-in agents consume the same registry service directly instead of making an HTTP request back into Huabu.

Agenetes remains authoritative for Agent Profiles, Deployments, threads, driver state, and Agentlet placement identity. It provides runtime context and registered resources but does not own Huabu's resource catalogue.

Agentlet remains the process and machine execution layer. The MVP does not add resource discovery to Agentlet. A future typed probe protocol may report machine-observed placements, but Agentlet does not own the registry or interpret Huabu resource semantics.

Every contributing subsystem remains authoritative for its own facts:

| Source | Authoritative facts |
| --- | --- |
| Huabu Skill loader | System Skills, Canvas overrides, and effective Skill content |
| RFS capability registry | Direct Space query and command contracts |
| Huabu hosted capability providers | Hosted-tool availability and invocation |
| SecretStore | Whether a logical secret is configured and injectable |
| Agenetes | Profiles, threads, placement identity, and runtime readiness |
| Canvas BlobStore | Artifact identity and availability |
| User registry configuration | Connector definitions, annotations, and declared machine placements |
| Future Agentlet probe | Machine-observed executable, cache, file, and version facts |

## 5. Design principles

### 5.1 Registry as projection, not duplicated storage

The registry federates existing sources and computes an effective view. It may cache projections and user-authored declarations, but it does not copy authoritative Skill bodies, Profile launch records, secret values, or artifact bytes.

```text
Skills / RFS capabilities / hosted tools / SecretStore
Agenetes Profiles and placement / artifacts / user declarations
                              |
                              v
                  Huabu registry projection
           filtered by machine/profile/canvas/thread
                              |
                  +-----------+-----------+
                  |                       |
                  v                       v
          RFS external adapter      built-in adapter
```

### 5.2 Strict contract, agent-friendly view

Runtime-validatable JSON schemas are authoritative for identity, authorization, access methods, status, and invocation. Markdown catalogues and meta prompts are generated views optimized for agent reading; they are never the source of truth.

The compact view contains only resource identity, kind, summary, readiness, and a link for loading details. Detailed schemas, instructions, or content are fetched on demand.

### 5.3 Definition is not placement

A Resource Definition describes a stable logical resource. A Placement describes how that resource applies at a particular host or machine. Paths and URLs are access locations, not resource identities.

```text
Resource Definition x applicable Placement = effective Resource projection
```

### 5.4 Requirements, not desired installation

The MVP Connector model declares what is required to perform a capability. It does not declare that Huabu must continuously keep a package installed on a machine.

If a user removes a declared executable, Huabu does not automatically reinstall it. The next attempted use fails explicitly, and an agent may propose or perform another user-authorized installation.

### 5.5 Agent-driven, host-verified evolution

An agent may discover a missing prerequisite, explain an installation recipe, request approval, perform an authorized installation, and request a registry refresh. It may not directly promote a placement to a trusted observed state.

The MVP has no generic machine verifier, so user-provided placements remain `declared`. A future trusted machine probe may add `observed` or `verified` evidence without changing the logical Resource Definition.

## 6. Conceptual model

The examples in this section are illustrative. Exact Zod schemas and field naming remain subject to the HackMD proof of concept, but every independently evolving contract carries an explicit schema version from its first release.

### 6.1 Resource Definition

A Resource Definition gives one logical resource a stable identity, kind, human-readable metadata, contract version, and kind-specific specification.

```yaml
schemaVersion: 1
id: executable.hackmd-cli
kind: executable
contractVersion: 1
name: HackMD CLI
summary: Command-line client used to publish and manage HackMD notes.
spec:
  command: hackmd
  versionConstraint: ">=1 <2"
annotations:
  whenToUse: Use through the HackMD Connector rather than invoking it without the Huabu publishing instructions.
```

`schemaVersion` versions the Resource Definition envelope. `contractVersion` versions the behavior or content contract of this particular resource.

### 6.2 Placement

A Placement relates a logical resource to a host or machine and describes its declared or authoritative access method.

```yaml
schemaVersion: 1
resourceId: executable.hackmd-cli
scope:
  kind: machine
  machineId: machine-a
source: user
status: declared
access:
  schemaVersion: 1
  kind: executable-path
  path: /usr/local/bin/hackmd
declaredVersion: 1.2.0
updatedAt: 2026-08-27T10:00:00Z
```

The MVP accepts user-authored placements with `source: user` and `status: declared`. A declaration means that the user intends the path or access method to be usable; it is not a trusted observation.

Huabu-hosted resources may use `source: host` and an authoritative `available` or `unavailable` status because Huabu can directly evaluate those facts. Future machine probes may use `source: machine-probe` with explicit observation and expiry fields.

### 6.3 Annotation

Annotations enrich resource discovery without altering trusted execution fields.

```yaml
schemaVersion: 1
resourceId: connector.hackmd
source: user
content:
  whenToUse: Publish a connected group of Space notes as one HackMD document.
  guidance: Inspect nodes connected to the selected note before publishing.
```

User annotations cannot override resource IDs, access methods, schemas, authorization, secret policies, limits, or provider-controlled readiness.

### 6.4 Connector Bundle

A Connector is a composite Resource Definition that declares requirements and instruction overlays. It is a capability recipe rather than a package archive or installed process.

```yaml
schemaVersion: 1
id: connector.hackmd
kind: connector
contractVersion: 1
name: HackMD Connector
summary: Publish Huabu Space content to HackMD.
spec:
  requirementsSchemaVersion: 1
  requirements:
    - resourceId: skill.hackmd.official
      relationship: required
    - resourceId: executable.hackmd-cli
      relationship: required
      versionConstraint: ">=1 <2"
    - resourceId: secret.hackmd-token
      relationship: required
    - resourceId: instructions.huabu-hackmd-publishing
      relationship: required
```

The initial dependency vocabulary is `required` only. `optional`, `one-of`, conflicts, and conditional dependencies require explicit schema evolution rather than being encoded in annotation prose.

### 6.5 Secret Requirement

A Secret Requirement identifies a logical prerequisite and its injection boundary without exposing the value.

```yaml
schemaVersion: 1
id: secret.hackmd-token
kind: secret-requirement
contractVersion: 1
name: HackMD API token
spec:
  secretId: integration:hackmd:token
  delivery: process-environment
  environmentVariable: HACKMD_TOKEN
  exposure: invocation-only
```

Registry projections may expose only `configured`, `injectable`, `missing`, or `forbidden`. They never include the value, ciphertext, provider endpoint, or a caller-selectable secret ID.

### 6.6 Access Method

Access is a versioned discriminated union. Initial conceptual variants include:

- `rfs-document` for Skills and generated guides.
- `rfs-download` for artifacts.
- `hosted-invocation` for Huabu tools such as web search and image generation.
- `agent-profile` for Agenetes-backed Agent creation.
- `executable-path` for a user-declared machine-local executable.
- `local-path` for a user-declared folder, Skill cache, or script.

Every access value carries its own `schemaVersion`. Callers must never infer access behavior from a path or URL string alone.

## 7. HackMD proof of concept

The HackMD Connector is the design proof of concept because it combines every important resource class:

1. The official HackMD Skill begins as a GitHub source and may have a different local cache on each machine.
2. `hackmd-cli` is installed independently on each machine, for example with `npm install -g`.
3. A HackMD token is stored in Huabu's SecretStore and injected only at an authorized execution boundary.
4. Huabu-specific instructions require the agent to inspect connected Space nodes before publishing.

### 7.1 Logical resources

```text
connector.hackmd
  requires skill.hackmd.official
  requires executable.hackmd-cli
  requires secret.hackmd-token
  requires instructions.huabu-hackmd-publishing
```

The official Skill and Huabu instruction overlay remain separate resources. Updating or replacing the upstream Skill cannot erase Huabu's publishing policy, and user annotation cannot mutate either trusted contract.

### 7.2 User-declared Machine A placements

```yaml
schemaVersion: 1
machineId: machine-a
placements:
  - schemaVersion: 1
    resourceId: skill.hackmd.official
    source: user
    status: declared
    access:
      schemaVersion: 1
      kind: local-path
      path: /home/user/.cache/huabu/skills/hackmd
  - schemaVersion: 1
    resourceId: executable.hackmd-cli
    source: user
    status: declared
    access:
      schemaVersion: 1
      kind: executable-path
      path: /usr/local/bin/hackmd
```

The token readiness comes from Huabu's SecretStore rather than the machine declaration. The Huabu instruction overlay comes from the Huabu registry provider. The effective Connector view combines all four sources.

### 7.3 Effective projection

```yaml
schemaVersion: 1
registryProtocolVersion: 1
resourceId: connector.hackmd
contractVersion: 1
scope:
  machineId: machine-a
  canvasId: canvas-123
  threadId: thread-456
readiness: declared
requirements:
  - resourceId: skill.hackmd.official
    status: declared
  - resourceId: executable.hackmd-cli
    status: declared
  - resourceId: secret.hackmd-token
    status: injectable
  - resourceId: instructions.huabu-hackmd-publishing
    status: available
```

Because the machine-local dependencies are user-declared, the aggregate readiness is `declared`, not `verified`. A failed invocation returns an explicit unavailable-resource result and does not silently downgrade or rewrite the user's declaration.

### 7.4 Agent-driven installation

The MVP does not reproduce the current Agent Team Setup state machine.

```text
Agent reads connector.hackmd
  -> sees executable.hackmd-cli missing or undeclared
  -> reads a trusted or user-authored installation recipe
  -> requests user approval when policy requires it
  -> runs npm install -g hackmd-cli on its current machine
  -> asks the user or registry API to add/update the declared Placement
  -> retries use under the normal resource error contract
```

An installation recipe is guidance and proposed action, not proof of installed state. The MVP records the resulting Placement as user-declared. A future machine probe can independently resolve the executable, read its version, and publish a time-bounded observation.

## 8. Projection and discovery

The registry computes an effective view from the authenticated runtime context:

```text
machine + agentlet placement + profile + canvas + thread + authorization
                                  |
                                  v
                      bounded Resource catalogue
```

Machine-scoped placements are included only for the current machine. Resources with a valid remote or Huabu-hosted access method may remain visible across machines when authorization permits.

The agent-facing surface follows an MCP-inspired list/detail/access split without requiring MCP as the initial transport:

```text
GET  $HUABU_RFS_URL/resources
GET  $HUABU_RFS_URL/resources/:resourceId
POST $HUABU_RFS_URL/resources/:resourceId/invoke
POST $HUABU_RFS_URL/resources/refresh
```

These paths are provisional. The shared wire contracts, not this path sketch, are authoritative once implementation begins.

The list response is bounded and paginated. Details include kind-specific schemas, requirements, annotations, limits, and access methods. Invocation exists only for invocable kinds; documents and artifacts use their advertised read or download access.

The RFS Skill bootstrap may render a compact Markdown table generated from the same projection:

| Resource | Kind | Summary | Readiness | Load |
| --- | --- | --- | --- | --- |
| `huabu.skill.layout` | Skill | Arrange Space content | Available | Resource detail |
| `connector.hackmd` | Connector | Publish Space content to HackMD | Declared | Resource detail |
| `huabu.tool.web-search` | Hosted tool | Search the current web | Available | Invocation detail |

## 9. Versioning

Versioning is mandatory from the first persisted or networked representation.

| Version | Scope |
| --- | --- |
| `registryProtocolVersion` | Catalogue projection, pagination, common discovery, and invocation envelope |
| Resource `schemaVersion` | Resource Definition envelope and common fields |
| Resource `contractVersion` | One logical resource's content, inputs, outputs, and behavioral semantics |
| Placement `schemaVersion` | Placement scope, provenance, status, and access binding |
| Access `schemaVersion` | Access-method discriminated union |
| Annotation `schemaVersion` | Annotation envelope and trusted/untrusted separation |
| Requirements `requirementsSchemaVersion` | Connector dependency expression |
| Observation `schemaVersion` | Future machine-probe evidence and expiry contract |

Adding a new optional field or resource kind may remain backward-compatible when old consumers can ignore it safely. Removing a field, changing required semantics, changing authorization meaning, or reinterpreting an existing enum requires a version change.

Unknown major schema versions fail explicitly. They must not be accepted with best-effort defaults. Migrations preserve provenance and never promote a user declaration to a host or machine observation.

## 10. Trust, authorization, and secrets

Registry visibility does not itself authorize access. Every read, download, invocation, Profile launch, and future refresh operation performs authorization at execution time.

The current process-global RFS bearer token is insufficient to prove Machine, Profile, or thread identity. The implementation must eventually bind a resource grant to the effective Agenetes placement, Profile, thread, Canvas, expiry, and capability allowlist. The exact grant contract is deferred, but no caller-supplied Machine or thread identifier becomes trusted merely because it appears in a request.

Trusted system fields and user-controlled prose remain structurally separate. User definitions and annotations are untrusted input and cannot select arbitrary provider credentials, widen Canvas scope, overwrite hosted access methods, or bypass confirmation policy.

Secrets remain in the SecretStore. Environment resource entries expose variable names, readiness, and injection policy only. Raw values never enter Registry storage, responses, prompts, generated Markdown, generated HTML, logs, or audit records.

## 11. Status and error semantics

The MVP distinguishes:

- `available`: the authoritative provider can currently confirm availability.
- `unavailable`: the authoritative provider can currently confirm absence or disabled state.
- `declared`: a user claims the placement is usable, but Huabu has not independently verified it.
- `forbidden`: the resource exists but is outside the caller's authorization.

Future machine observation may add `observed`, `verified`, `stale`, or `unknown` only through an explicit Placement/Observation schema version.

Failures are explicit and stable: unsupported schema version, resource not found, forbidden, unavailable, invalid input, missing secret, timeout, quota exceeded, provider failure, and non-retryable side effect. An error never takes the shape of a successful result.

## 12. Relationship to existing surfaces

`GET /agent/profiles` is an early specialized registry projection: Agenetes owns Profile facts, Huabu filters and redacts them, and RFS publishes stable IDs and aliases. The general registry should eventually represent Profiles as `agent-profile` resources without immediately removing the compatibility endpoint.

RFS Skills such as `layout`, `tasks`, `agents`, and `interactive-views` become `skill` resources whose access method points to the existing authenticated guide. Their content and override rules remain owned by the Skill loader.

RFS direct Space queries and commands remain their own canonical protocol. The registry links to those capabilities rather than duplicating their schemas.

Issue #110 introduces `web_search` and `generate_image` as the first `hosted-tool` resources. Their provider credentials stay server-side, and native and external invocation must share one handler and contract.

## 13. Delivery plan

### Phase 1: HackMD definition POC

- Define versioned Resource, Placement, Annotation, Connector requirement, Secret Requirement, and Access Method schemas.
- Persist user-authored Connector definitions, annotations, and declared placements in Huabu-owned storage.
- Project one HackMD Connector for the current machine.
- Generate a compact Markdown catalogue from the strict projection.
- Document explicit manual or agent-assisted placement updates after installation.

### Phase 2: Existing Huabu resources

- Project existing RFS Skills and direct-operation capabilities.
- Project Agenetes Agent Profiles through the registry while preserving `/agent/profiles`.
- Project hosted-resource and SecretStore readiness without exposing secret values.

### Phase 3: Issue #110 hosted capabilities

- Register web search and image generation as versioned hosted tools.
- Share native and RFS invocation handlers, validation, timeout, quota, error, and audit semantics.
- Add scoped resource grants for external invocations.

### Phase 4: Optional machine observation

- Evaluate a narrow typed Agentlet probe protocol.
- Verify executable paths, versions, Skill cache digests, and artifact metadata without arbitrary command execution.
- Add observation expiry, offline-machine behavior, and declared-versus-observed conflict presentation.

## 14. Open questions

1. Which Huabu-owned file or structured store persists user Resource Definitions and Placements?
2. How is the current Machine identity derived and displayed when a local command Profile and an Agent Team Profile target the same Agentlet?
3. Are installation recipes standalone resources or versioned fields on executable definitions?
4. Which installation actions require per-use confirmation, and can a user grant a durable policy for one package and machine?
5. Should a failed resource use affect only the current invocation, or also attach non-authoritative failure evidence to its declared Placement?
6. What are the minimum dependency relations after `required`: `optional`, `one-of`, or conditional requirements?
7. How are upstream Skill commits pinned, cached, updated, and attributed?
8. Which compatibility endpoints remain indefinitely after equivalent Registry resources ship?

## 15. Acceptance criteria

- Huabu owns one versioned Resource Registry projection service usable by built-in and external agents.
- Every durable or wire-level Resource, Placement, Access, Annotation, Requirements, and future Observation contract carries an explicit schema version.
- A HackMD Connector combines an official Skill, user-declared machine-local CLI placement, Secret Requirement, and Huabu instruction overlay.
- Machine-local declarations are labeled `declared` and never represented as trusted observations.
- An agent can discover the compact Connector summary, load its details, identify missing requirements, and follow an installation recipe without a new Agentlet probe protocol.
- Secret values never enter Registry state or agent-visible output.
- Existing subsystem records remain authoritative and are not duplicated into Registry storage.
- The MVP does not implement desired-installation reconciliation or automatic reinstallation.
- Issue #110 can add web search and image generation as hosted resources without inventing a separate discovery model.

## 16. Code entry points

| File/dir | Responsibility |
| --- | --- |
| [`apps/server/src/modules/remote_fs/`](../../apps/server/src/modules/remote_fs/) | RFS discovery and external-agent adapter surface. |
| [`apps/server/src/modules/agent/tools/`](../../apps/server/src/modules/agent/tools/) | Existing built-in tool definitions and handlers to project or share. |
| [`apps/server/src/prompt/skills/`](../../apps/server/src/prompt/skills/) | Existing Huabu Skill definitions and loader inputs. |
| [`apps/server/src/security/secret-store.ts`](../../apps/server/src/security/secret-store.ts) | Secret readiness and server-side value boundary. |
| [`apps/server/src/modules/agent/acp/`](../../apps/server/src/modules/agent/acp/) | External-agent context and reachback environment assembly. |
| [`external/agenetes/packages/agent-team/`](../../external/agenetes/packages/agent-team/) | Existing Agent Profile, Config, and placement resource source. |
| [`external/agenetes/packages/agentlet-gateway/`](../../external/agenetes/packages/agentlet-gateway/) | Authenticated routing to Agentlet machines and possible future typed probes. |
| [`external/agentlet/spec/agent-reachback.md`](../../external/agentlet/spec/agent-reachback.md) | Host-agnostic reachback transport and environment boundary. |
| [`packages/shared/src/types/api/`](../../packages/shared/src/types/api/) | Future canonical versioned RFS Registry wire contracts. |

