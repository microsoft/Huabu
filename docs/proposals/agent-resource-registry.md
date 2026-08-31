# Agent Resource Registry and External Agent Capabilities

Status: Accepted

Last updated: 2026-08-31

Tracking issues: [#120](https://github.com/microsoft/Huabu/issues/120), [#110](https://github.com/microsoft/Huabu/issues/110)

Supersedes: the earlier machine-aware registry draft previously stored at this path

## 1. Decision

Agenetes will provide a compact, agent-readable Resource Registry as a general control-plane primitive alongside Agent Profiles. Profiles select resources by ID, profile realization supports a bounded resource override, and Huabu mounts the reusable registry through owner-facing and RFS HTTP adapters.

The catalogue is deliberately descriptive rather than executable. Each record tells an agent what a resource is, who provides it, and how to access or use it through natural-language instructions. It does not model installation state, runtime availability, authorization state, input/output contracts, or provider configuration.

Delivery is split into three phases:

1. Phase 1 establishes the independent Agenetes Resource Registry, versioned Profile resource composition, launch overrides, local resource management, and Huabu adapters without integrating with or changing Agent Team Setup.
2. Phase 2 registers Huabu-hosted capabilities such as web search and image generation, with credentials and policy enforcement remaining inside Huabu.
3. Phase 3 converts bundled Agent Team presets into ordinary External Agent Profiles composed from registry resources and eventually replaces the current Agent Team Setup flow with agent-assisted local resource installation.

Phase 1 and Phase 2 are planned for one implementation pull request. Phase 3 remains a separate migration because it removes an existing preparation and security boundary.

## 2. Problem

Huabu currently exposes resources through unrelated mechanisms:

- the Huabu Access Skill and focused RFS guides;
- direct RFS Space query and command capabilities;
- built-in Huabu agent tools;
- command-backed External Agent Profiles;
- Agent Team manifests, Configs, setup state, and prepared workspaces;
- Agentlet-managed shared npm tools and distributed files;
- machine-local Skills, scripts, connectors, and executables.

An external agent has no single answer to three basic questions:

1. Which resources are available to this Profile?
2. Which resources exist on the machine where this agent is running?
3. How should the agent read or invoke each resource?

The current Agent Team model packages these concerns together. This works for fixed presets but makes capabilities difficult to compose across ordinary External Agent Profiles and encourages a new bespoke integration for every hosted tool.

## 3. Goals

1. Define one minimal, versioned Agenetes catalogue record for host-provided and machine-local agent resources.
2. Make resource discovery compact and directly understandable by an agent.
3. Let an External Agent Profile select a set of resources.
4. Attach Huabu Access and Local Resource Management to External Agent Profiles by default.
5. Project machine-local resources only to agents running on the applicable Agentlet machine.
6. Keep provider credentials and managed Config values outside registry records, prompts, durable WorkloadSpecs, generated files, and client-visible state.
7. Give Agenetes one authoritative Resource Registry rather than copying resource records into host-specific stores.
8. Preserve existing Agent Team Setup during Phases 1 and 2.
9. Give hosted capabilities one shared implementation used by built-in and external agents.
10. Make the Phase 3 removal of Agent Team Setup conditional on replacing all of its preparation and validation guarantees.
11. Keep runtime availability, installation evidence, authorization, and capability-specific contracts outside the catalogue record.

## 4. Non-goals

- Building a general package marketplace.
- Automatically installing arbitrary resources without user approval.
- Treating agent-authored claims as proof that a resource is installed or safe.
- Continuously reconciling desired software state on every machine.
- Copying secret values or complete Agent Team manifests into the registry.
- Removing Agent Team Setup in Phase 1 or Phase 2.
- Giving external agents arbitrary provider, credential, endpoint, model, Canvas, Profile, machine, or thread selection.
- Replacing RFS Space query and command contracts.
- Requiring MCP as the initial transport.
- Defining a general machine-executable resource access protocol.
- Persisting or synchronizing resource availability in the catalogue.

## 5. Ownership

Agenetes owns the `AgentResource` contract, Resource Registry service and persistence, Profile resource IDs, Profile schema migration, workload resource snapshots, and generic override semantics. The registry exposes services rather than depending on an HTTP framework.

Huabu Server mounts the Agenetes Resource Registry and Agent Profile services into authenticated HTTP routes, registers Huabu Skills and hosted capability records, defines Huabu-required default resources, applies host authorization policy, and projects catalogue records through the canvas-scoped RFS adapter.

Agentlet owns the physical machine resource root, installation receipts, executable resolution, and the process environment supplied to agents on that machine. It registers or withdraws machine-local catalogue records through the Agenetes service without making the catalogue responsible for installation state.

Existing subsystems remain authoritative for their own facts:

| Source | Authoritative facts |
| --- | --- |
| Huabu external-agent Skill loader | Huabu Access and focused guide instructions |
| Huabu hosted capability service | Hosted capability schema, readiness, policy, and invocation behavior |
| Huabu SecretStore | Credential availability and secret values |
| Agenetes Resource Registry | Resource identity, catalogue persistence, lookup, and provider registration |
| Agenetes Agent Profile registry | Profile identity, schema version, placement, launch configuration, and selected resource IDs |
| Agentlet resource manager | Local installation paths, receipts, versions, and validation |
| Existing Agent Team registry | Member Config, preparation, and prepared runtime state during migration |

## 6. Resource model

The registry is a simple resource catalogue. It intentionally avoids discriminated resource kinds and separate models for placement, availability, requirements, observations, connectors, secrets, or access protocols.

Every record has the same shape:

```ts
interface AgentResource {
  schemaVersion: 1;
  id: string;
  name: string;
  provider: string;
  description: string;
  instructions: string;
}
```

The fields have narrow meanings:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Version of the `AgentResource` record format |
| `id` | Stable, globally unique, human-readable kebab-case identifier |
| `name` | Human-facing display name |
| `provider` | Stable authority ID publishing the record; Phase 1 uses `huabu` or the exact Agentlet machine ID |
| `description` | Short catalogue summary used for browsing and Profile selection |
| `instructions` | Natural-language directions telling the agent how to access and use the resource |

`instructions` combines the former structured access and inline content concepts. It may reference an RFS URL, an `AGENT_RESOURCE_DIR` path, an HTTP method, or an injected credential variable, but it never contains a secret value. For example, the Huabu Access record can direct the agent to fetch `$HUABU_RFS_URL/skill` with a bearer token read from the `AGENTLET_TOKEN` environment variable.

The catalogue is agent-readable rather than a machine-executable protocol. Huabu and Agentlet do not parse `instructions` to infer authorization, availability, installation state, capability schemas, or command execution. Those concerns remain with the owning subsystem and are checked when the resource is resolved or used.

`schemaVersion` versions only this common record format. A hosted API contract, Skill revision, CLI version, installation receipt, or policy version is independently owned and versioned outside the catalogue.

The Agenetes registry provides framework-independent operations to list, look up, register, replace, and withdraw resource records. Phase 1 registration is provider-driven; Huabu does not add a general resource-authoring UI or allow an external agent to publish trusted records by editing catalogue state.

Withdrawing a record does not cascade into Profiles or durable workloads. A Profile may temporarily retain an unresolved resource ID when a provider disconnects or a resource is removed; editing and realization surface that condition explicitly.

Resource IDs are unique across the registry. Registration of an existing ID succeeds only as an explicit replacement by the same provider; a different provider receives a conflict. Records, descriptions, and instructions are bounded by the canonical Agenetes schemas, and list order is stable by resource ID.

Registration is a privileged provider operation. Third-party `instructions` are selected user-facing resource content, not host policy, and are never promoted into the mandatory Huabu system preamble; that preamble contains only effective resource IDs and the authenticated catalogue bootstrap.

The first persistent store uses its own versioned `resources.json` envelope under the Agenetes host storage directory, atomic replacement, and owner-only file permissions where supported. Unknown store or record schema versions fail explicitly. This store is independent from the current Agent Team `registry.json`.

## 7. Initial registry

The initial registry contains:

| Resource ID | Name | Provider | Example instruction |
| --- | --- | --- | --- |
| `huabu-access` | Huabu Access | `huabu` | Fetch `$HUABU_RFS_URL/skill` with the injected Agentlet token and follow the returned guide |
| `local-resource-management` | Local Resource Management | `huabu` | Fetch the focused RFS Skill and follow it before installing or changing local resources |
| `web-search` | Web Search | `huabu` | Invoke the documented RFS endpoint using the current session authorization |
| `generate-image` | Generate Image | `huabu` | Invoke the documented RFS endpoint and use the returned Canvas artifact |
| `hackmd-publisher` | HackMD Publisher | Agentlet machine ID | Read and follow the Skill under `$AGENT_RESOURCE_DIR` |
| `deepv-slides-maker` | DeepV Slides Maker | Agentlet machine ID | Read and follow the installed local Skill |
| `html-slides-maker` | HTML Slides Maker | Agentlet machine ID | Read and follow the installed local Skill |

IDs do not encode resource type, provider, machine, or storage location. Provider and instructions carry those facts without making them part of stable identity. Absolute machine paths may appear in authorized instructions but never become the resource ID.

## 8. Local resource management

Agentlet provides `AGENT_RESOURCE_DIR` to every spawned external agent. The default is an absolute machine-local directory under `~/.agentlet/resources`.

```text
~/.agentlet/resources/
  skills/       # cloned or installed Agent Skills
  tools/        # managed CLI packages and launch shims
  connectors/   # resource bundles such as HackMD publishing
  receipts/     # machine-owned installation and validation records
```

The physical root belongs to Agentlet because Agentlet knows the execution machine and launches the process that consumes these files. Huabu receives a bounded projection of validated resource metadata; it does not scan arbitrary machine paths itself.

The Local Resource Management Skill explains how an external agent:

1. inspects the current resource catalogue;
2. identifies a missing Skill, connector, or CLI;
3. presents the exact source, version or commit, destination, and commands to the user;
4. obtains user approval before installation or mutation;
5. installs only under `AGENT_RESOURCE_DIR` unless the user explicitly authorizes another location;
6. validates the expected entrypoint and records a receipt;
7. requests a registry refresh;
8. updates or removes a resource without editing the user's project directory.

The Skill is procedural guidance, not an authorization mechanism. Installation remains subject to the external harness permission flow and host policy.

An agent cannot establish installation or trust by editing catalogue state. Agentlet validates local paths and receipts when projecting a local record and again when resolving the resource for a workload. These checks do not add an availability field to the catalogue.

## 9. Profile resource composition and overrides

Resources are a first-class, generic Agent Profile concept rather than Huabu-owned `customData`. Profile schema v2 adds `schemaVersion` and `resourceIds`:

```ts
interface AgentProfileBase {
  schemaVersion: 2;
  id: string;
  alias: string;
  agentletId: string;
  workingDirPath: string;
  resourceIds: string[];
  customData?: Record<string, JsonValue>;
}
```

Profile schema v1 is the existing record shape with no per-record `schemaVersion` and no `resourceIds`. The store accepts a missing version only as legacy v1, migrates it to v2 with `resourceIds: []`, and writes all current Profiles with an explicit `schemaVersion: 2`. New create requests do not choose a schema version; Agenetes creates v2 records. API responses always return v2.

The Agent Profile registry file schema advances from v3 to v4 because its persisted Profile records change. Existing registry file schemas continue through the current migration path, normalize every Profile to v2, and are rewritten as registry file v4. Compatibility parsing remains at the store boundary; application code handles only Profile v2.

Every ordinary External Agent Profile has a set of logical resource IDs. Manifest-backed Profiles also receive the v2 field for schema consistency, but Phase 1 does not derive those IDs from manifests and does not change their Setup or runtime preparation behavior.

`huabu-access` and `local-resource-management` are default resources. Other resources are optional and selected by the user.

A bounded launch override mirrors `workingDirPath` replacement semantics:

```ts
interface AgentProfileOverrides {
  workingDirPath?: string;
  resourceIds?: string[];
}
```

`resourceIds`, when present, completely replaces the Profile's selectable resource IDs; an empty array means no optional resources. Huabu then unions its required defaults with that selected list:

```text
selected = override.resourceIds ?? profile.resourceIds
effective = unique(requiredHuabuResourceIds + selected)
```

Agenetes does not hard-code Huabu defaults. The host supplies required resource IDs and placement policy at realization. Huabu-specific `additionalInitialPreamble` remains in Huabu's launch override rather than becoming a generic Profile field.

Profile selection is constrained by placement:

- Huabu-hosted resources are eligible for any local External Agent Profile when host policy allows them.
- A machine-local resource is eligible only when its `provider` equals the Profile's `agentletId`.
- A missing, stale, or inaccessible resource produces an explicit resolution or launch error outside the catalogue record and does not become usable at runtime.

Create, patch, and launch override inputs use one bounded canonical resource-ID list schema: IDs are trimmed, unique, known to the registry, and eligible for the Profile placement. Profile patch replaces the complete list. Provider withdrawal may later make a stored reference unresolved, so realization repeats validation and fails explicitly instead of silently dropping an ID.

The override is accepted everywhere the existing working-directory launch override is accepted, including fixed Agent Node creation, RFS Agent creation, and Task Run creation. It applies only before the thread's first realization; an existing durable workload remains authoritative.

When a thread first realizes a Profile, the effective resource IDs are snapshotted into `AgentProfileSnapshot`. This is a backward-compatible addition to Agent Profile driver workload v1: its schema accepts an absent snapshot `resourceIds` as `[]`, while every newly created workload writes the field explicitly. The driver version therefore remains v1 and existing durable threads require no workspace migration. Later Profile edits, resource overrides, or required-default changes do not silently change an existing thread.

Secrets are resolved at invocation or process-spawn time through runtime ports. Secret values never enter the Profile record or durable resource snapshot.

## 10. Discovery

Huabu mounts the Agenetes catalogue for Settings:

```text
GET /api/acp/resources
```

This owner-only endpoint returns the global catalogue used by the External Agent Profile create/edit resource picker. Profile create and patch requests carry `resourceIds`; Huabu validates the wire contract and delegates storage and resource-reference validation to Agenetes.

RFS exposes a canvas-scoped catalogue projection:

```text
GET $HUABU_RFS_URL/resources
```

The response contains complete safe `AgentResource` records visible to the current Agentlet because each record is intentionally compact. The current RFS token is Agentlet-wide and does not prove Profile or thread identity, so Phase 1 does not pretend this endpoint is a Profile-authorized view. The global definitions are shared across Huabu, while `$HUABU_RFS_URL` and other variables referenced by instructions resolve in the current Agent session. A catalogue record never persists a concrete canvas-specific RFS URL or bearer token.

The external-agent bootstrap contains the effective selected resource IDs and the catalogue endpoint. It does not inline the complete catalogue or every Skill body. Because the initial preamble is part of the durable workload, resumed threads retain the same selected IDs.

Catalogue discovery and Profile selection are not invocation authorization. Phase 1 records contain no secrets, and the RFS adapter exposes only safe catalogue text through the existing canvas-scoped token boundary. The realized workload tells the agent which records compose its Profile. Resource resolution and invocation enforce current placement, installation, configuration, and authorization independently. Phase 2's session-scoped grant, not catalogue visibility, authorizes hosted invocation.

## 11. Hosted capability invocation

Phase 2 adds:

```text
POST $HUABU_RFS_URL/resources/:resourceId/invoke
```

The request contains capability-specific input validated against the canonical hosted capability schema and an optional caller correlation ID. That schema belongs to the invocation endpoint and is not part of `AgentResource`.

The request does not accept Canvas ID, Profile ID, thread ID, machine ID, provider, credential ID, API key, or unrestricted model and endpoint overrides.

The server derives scope and allowed resource IDs from a runtime capability grant associated with the external Agent session.

The current process-global Agentlet token is not sufficient for this authorization because it does not prove Profile or thread identity. Phase 2 therefore introduces a short-lived, opaque, session-scoped grant. The grant is delivered at runtime and is not stored in the durable WorkloadSpec.

Hosted invocation uses one shared capability service:

```text
Built-in tool adapter ─┐
                       ├─ hosted capability service ─ provider
External RFS adapter ─┘
```

The current built-in `web_search` and `generate_image` handlers become adapters over this service. Native and external invocation therefore share validation, provider configuration, timeout, cancellation, quota, result shaping, and errors.

## 12. Credential and environment boundary

Provider secrets stay in Huabu's SecretStore and are resolved only inside the hosted capability service.

Registry and discovery responses never expose runtime readiness, credential state, or secret metadata. They also never expose:

- raw secret values or ciphertext;
- SecretStore identifiers;
- provider credential environment-variable names;
- privileged provider configuration;
- arbitrary caller-selectable endpoints, credentials, providers, or models.

Huabu must also prevent environment-backed provider credentials from reaching external agents.

Agentlet currently spawns agents with its inherited process environment, while Huabu strips only the `HUABU_` namespace before starting the daemon. Environment fallbacks such as `TAVILY_API_KEY`, `RAPIDAPI_KEY`, `AZURE_OPENAI_API_KEY`, and provider-specific API-key variables must be removed from the daemon and spawned-agent environment unless an explicit resource contract authorizes delivery.

The daemon-owned `AGENTLET_TOKEN`, the RFS base, the thread identity, the session-scoped resource grant, and `AGENT_RESOURCE_DIR` are explicit runtime injections. Ambient host environment inheritance is not a resource-delivery mechanism.

## 13. Authorization, limits, and audit

The effective hosted capability grant binds:

- Agentlet placement;
- Profile ID;
- Canvas ID;
- thread ID;
- allowed resource IDs;
- expiry;
- policy version.

Caller-supplied headers may provide correlation hints but cannot establish any of these identities.

Each hosted capability publishes bounded policy metadata:

- request size;
- result size;
- timeout;
- maximum concurrency;
- request or cost quota where applicable;
- retry safety;
- side-effect classification.

Web search retains a bounded result count and a provider deadline. Image generation remains sequential per authorized scope, has a longer provider deadline, and writes artifacts only into the grant's Canvas BlobStore.

Every invocation produces a sanitized audit record containing the resource ID, trusted scope identifiers, correlation ID, start/end time, outcome code, latency, and policy version. Audit records exclude secrets, authorization headers, full provider payloads, generated image bytes, and sensitive command environments.

## 14. Error contract

Hosted resource invocation returns either a typed success or one stable error:

- `unsupported_version`
- `resource_not_found`
- `forbidden`
- `unavailable`
- `invalid_input`
- `cancelled`
- `timeout`
- `quota_exceeded`
- `provider_failure`
- `internal_error`

Errors never use a success-shaped result. Provider errors are mapped to the stable taxonomy and sanitized before leaving the server.

Retry guidance is explicit. Read-only web search may be retryable after transient provider failure. Image generation is not blindly retryable after an unknown transport outcome because the provider may have completed a billed operation.

## 15. Versioning

The catalogue record format and related runtime contracts evolve independently:

| Version | Scope |
| --- | --- |
| Agent Profile registry file v4 | Persisted registry envelope containing normalized Profile v2 records |
| Agent Profile schema v2 | Adds explicit per-record version and first-class `resourceIds`; missing version is legacy v1 |
| Agent Profile driver workload v1 | Adds optional-on-read, explicit-on-write effective resource IDs without changing the driver version |
| Resource Registry file v1 | Independent `resources.json` persistence envelope |
| Catalogue protocol version | List envelope, pagination, and transport behavior |
| `AgentResource.schemaVersion` | Common catalogue record fields and their semantics |
| Hosted capability contract version | One invocation endpoint's behavior and input/output schema |
| Grant policy version | Authorization and limit interpretation |
| Receipt schema version | Agentlet local installation and validation evidence |

Adding an optional field is compatible only when older callers can safely ignore it. Removing fields, changing authorization meaning, changing required input, or reinterpreting an enum requires a major version change.

An unsupported `AgentResource.schemaVersion` fails explicitly; it is never accepted through best-effort coercion. The initial catalogue does not add per-resource contract versions.

## 16. Phase 1 acceptance

Phase 1 is accepted when:

1. Agenetes persists and serves the minimal `AgentResource` catalogue through framework-independent registry operations.
2. Huabu mounts the catalogue for Settings and through the canvas-scoped RFS adapter.
3. An ordinary External Agent Profile can select resources in addition to Huabu-required defaults.
4. Profile records without a schema version migrate from v1 to explicit v2 with `resourceIds: []`, and the registry file migrates to v4.
5. Profile create and patch responses contain explicit Profile schema v2 records.
6. A launch override can completely replace the Profile's optional resource IDs, including replacing them with an empty list.
7. Huabu-required default resources remain effective after an override without being hard-coded by Agenetes.
8. A Profile cannot select a local resource from another Agentlet machine.
9. A new thread writes effective resource IDs into its Agent Profile workload v1 snapshot, while an existing snapshot without the field reads as an empty list.
10. The external agent can identify its selected resource IDs and load the corresponding instructions.
11. Missing or invalid local resources fail explicitly during resolution or launch without mutating the catalogue record.
12. Secret values remain absent from Resource records, Profile records, WorkloadSpecs, prompts, logs, and client-visible responses.
13. Existing command-backed and manifest-backed Profile launch behavior remains compatible.
14. Agent Team manifests do not implicitly create resources in Phase 1.
15. Agent Team Setup, preparation state, Config resolution, workspace materialization, and runtime environment behavior remain unchanged.

## 17. Phase 2 acceptance

Phase 2 is accepted when:

1. `web-search` and `generate-image` appear in the catalogue when selected by the effective Profile and allowed by host policy.
2. Invocation checks server-side configuration without exposing configuration or secrets through the catalogue.
3. An authorized external agent can invoke each resource through RFS.
4. Built-in and external adapters use the same capability service.
5. The caller cannot select arbitrary credentials, endpoints, providers, models, Canvas IDs, Profile IDs, machines, or threads.
6. Invalid, forbidden, unavailable, cancelled, timed-out, quota-exceeded, and provider-failure requests return stable errors.
7. Image artifacts are written only to the authorized Canvas.
8. Environment-backed provider credentials are absent from external agent processes.
9. Sanitized invocation audit records are produced.
10. Existing native Huabu tool behavior remains compatible.

## 18. Phase 3 migration

Phase 3 converts bundled presets from manifest-backed Agent Team Profiles into ordinary External Agent Profiles with selected resources.

This phase may remove Agent Team Setup only after the replacement provides:

- trusted source and version selection;
- user approval before installation;
- deterministic installation destinations;
- installation receipts;
- executable and Skill validation;
- shared-resource concurrency control;
- update and removal behavior;
- secret injection at runtime;
- machine-offline and stale-resource handling;
- preparation diagnostics;
- no writes into the user's project directory unless explicitly authorized.

Migration must preserve existing Profile and thread behavior. Existing durable threads continue from their snapshotted workload even if their source preset is later converted or removed.

## 19. Implementation outline

### Phase 1: issue #120

1. Add the canonical `AgentResource` Zod contract to `@agenetes/protocol` and a framework-independent Resource Registry service with versioned persistence in a new Agenetes package.
2. Add Profile schema v2 with first-class `resourceIds`, registry file v4 migration, and Profile create/patch support.
3. Add generic replacement-style `resourceIds` launch overrides and backward-compatible Agent Profile workload v1 snapshot parsing.
4. Mount the owner-only resource list API in Huabu and add resource selection to ordinary External Agent Profile create/edit UI.
5. Register the two Huabu default records and apply required-default policy during Huabu workload realization.
6. Add Agentlet `AGENT_RESOURCE_DIR`, receipt storage, and bounded provider registration for machine-local resources without reading Agent Team manifests or workspaces.
7. Add the Local Resource Management Skill.
8. Add the canvas-scoped safe catalogue view and include effective selected resource IDs in the durable external-agent bootstrap.
9. Add compatibility coverage proving Agent Team Setup and manifest-backed runtime behavior are unchanged.

### Phase 2: issue #110

1. Extract web search and image generation into shared hosted capability services.
2. Register both services as hosted resources.
3. Add runtime session-scoped grants and the invocation route.
4. Add shared cancellation, timeout, quota, error, and audit handling.
5. Remove provider secret variables from inherited external-agent environments.
6. Add native/external parity and authorization regression coverage.

### Phase 3: separate migration issue

1. Represent bundled preset requirements as registry resource selections.
2. Create ordinary External Agent Profiles from those selections.
3. Add agent-assisted installation backed by receipts and validation.
4. Migrate existing preset Profiles.
5. Remove Agent Team Setup only after all migration invariants pass.

## 20. Documentation changes

Phase 1 updates:

- `docs/architecture/agent-reachback.md`
- `docs/architecture/agent-teams-as-extensions.md`
- `docs/architecture/agent-architecture.md`
- `external/agentlet/spec/agent-reachback.md`
- a new architecture document for Agent Resource Registry and local resource management

Phase 2 additionally updates:

- `docs/architecture/credential-storage.md`
- `docs/architecture/deployment-security.md`
- the external-agent Huabu Access Skill

After each phase ships, implemented behavior moves into architecture documentation while this Proposal remains the historical decision record.

## 21. Code entry points

| File/dir | Responsibility |
| --- | --- |
| [`apps/server/src/modules/remote_fs/`](../../apps/server/src/modules/remote_fs/) | External discovery and invocation adapter |
| [`apps/server/src/prompt/external-agent/`](../../apps/server/src/prompt/external-agent/) | Huabu Access and Local Resource Management Skills |
| [`apps/server/src/modules/agent/tools/`](../../apps/server/src/modules/agent/tools/) | Existing built-in adapters for hosted capabilities |
| [`apps/server/src/security/secret-store.ts`](../../apps/server/src/security/secret-store.ts) | Server-side credential boundary |
| [`apps/server/src/modules/agent/acp/`](../../apps/server/src/modules/agent/acp/) | Profile workload assembly and runtime injection |
| [`external/agenetes/packages/agent-team/`](../../external/agenetes/packages/agent-team/) | Current unified Profile registry, Profile v2 migration, and unchanged Agent Team preparation |
| [`external/agenetes/packages/protocol/`](../../external/agenetes/packages/protocol/) | Canonical `AgentResource` and generic Profile override schemas |
| `external/agenetes/packages/resource-registry/` | New framework-independent registry service and persistence |
| [`external/agentlet/packages/local/`](../../external/agentlet/packages/local/) | Machine resource root, environment, receipts, and agent process spawn |
| [`external/agentlet/packages/agent-team/`](../../external/agentlet/packages/agent-team/) | Existing setup materializer whose behavior remains unchanged during Phases 1 and 2 |
| [`packages/shared/src/types/api/`](../../packages/shared/src/types/api/) | Huabu HTTP envelopes that reuse Agenetes resource and override schemas |
| [`agent-teams/`](../../agent-teams/) | Phase 3 migration inputs; not a Phase 1 resource source |
