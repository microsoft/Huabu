# Agent Resources

## Overview

Agent Resources are the composable capability catalogue for external Agent Profiles. Agenetes owns the generic catalogue and Profile references, Agentlet owns machine-local installation evidence and paths, and Huabu owns required defaults, authenticated HTTP projection, hosted capability policy, and provider credentials.

The catalogue is descriptive. An `AgentResource` tells an agent what a resource is and how to use it, but it does not encode runtime availability, authorization, secrets, provider configuration, or a machine-executable invocation contract.

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

## Registry and provider reconciliation

`@agenetes/resource-registry` stores a versioned `resources.json` independently from the Agent Team registry. Registration validates the canonical `@agenetes/protocol` schema, records are sorted by ID, same-provider replacement is explicit, and cross-provider ID collisions fail. `replaceProviderResources()` atomically reconciles one provider's complete projection and withdraws stale records.

Huabu mounts the registry through `@agenetes/agentlet-host`. Startup reconciles the complete `huabu` projection and the complete projection for the supervised Agentlet machine, including an empty machine projection. Owner Settings reads the global catalogue through `GET /api/acp/resources`; RFS reads only `huabu` records and records whose provider equals the supervised Agentlet ID through `GET $HUABU_RFS_URL/resources`.

The initial Huabu records are `huabu-access`, `local-resource-management`, `web-search`, and `generate-image`. The first two are required for every external Agent; hosted capabilities remain optional Profile selections.

## Profile composition and workload snapshots

Agent Profile schema v2 adds an explicit `schemaVersion: 2` and `resourceIds: string[]`. The Agent Team registry envelope is v4. Legacy Profiles without a per-record version migrate to v2 with an empty optional selection, and create and patch validate bounded, unique, known, placement-eligible IDs. Provider withdrawal does not rewrite Profiles, so an unavailable selected ID remains visible and realization fails explicitly.

Launch overrides use complete-replacement semantics:

```text
selected = launchOverride.resourceIds ?? profile.resourceIds
effective = unique(huabuRequiredResourceIds + selected)
```

An empty override therefore removes all optional resources without removing Huabu's required defaults. Fixed Agent, RFS Agent, and Task Run launch paths use the same rule.

Huabu persists the effective IDs in the ACP workload v1 spec when a thread is first realized. The field is optional-on-read and defaults to `[]` for legacy workloads, while new workloads always write it. A non-secret resource scope snapshots the Canvas and thread IDs needed to mint runtime authorization. Existing durable workloads remain authoritative after Profile edits or provider withdrawal.

## Machine-local resources

Agentlet injects the absolute `AGENT_RESOURCE_DIR` into every spawned external Agent. Its fixed layout is:

```text
~/.agentlet/resources/
  skills/
  tools/
  connectors/
  receipts/
```

An operator override must be absolute. Receipts are versioned Agentlet records written atomically with owner-only permissions where supported. Receipt IDs must match filenames, entrypoints must exist, and realpath validation rejects traversal and symbolic-link escape. Enumeration accepts only receipts whose provider equals the supervised Agentlet machine and emits sanitized diagnostics for invalid records.

The required Local Resource Management Skill tells an external Agent to obtain user approval, install only under `AGENT_RESOURCE_DIR`, validate the entrypoint, and submit the bounded receipt through `POST $HUABU_RFS_URL/resources/local/receipts`. Huabu stamps provider and installation time, delegates receipt validation to `@agentlet/resources`, and reconciles the machine provider. `DELETE $HUABU_RFS_URL/resources/local/receipts/:resourceId` removes the receipt and withdraws its catalogue record; installed files are removed separately by the approved external-Agent operation.

## Hosted capabilities

`web-search` and `generate-image` share one service implementation between built-in tool adapters and the RFS adapter. Their canonical request inputs live in `@huabu/shared`; provider selection, endpoint selection, credentials, and image Canvas destination are never caller-controlled.

Hosted invocation uses `POST $HUABU_RFS_URL/resources/:resourceId/invoke`. The ordinary RFS bearer token authenticates the Agentlet, while `X-Huabu-Resource-Grant` authorizes the realized Profile and thread. The opaque runtime-only grant binds Agentlet, Profile, Canvas, thread, allowed resource IDs, expiry, and policy version. It is injected when ACP spawns or resumes a process and is never written into the durable workload environment.

Web search enforces canonical input limits, a provider deadline, bounded result count and text, and shared cancellation. Image generation is sequential per grant, validates model-family size and quality, bounds reference and generated bytes, and writes only to the BlobStore for the grant's Canvas. Request disconnect aborts the provider operation.

Hosted errors use a stable taxonomy and external responses sanitize provider and configuration detail. Audit logs use trusted grant fields and include resource, Profile, Agentlet, Canvas, thread, correlation ID, outcome, latency, and policy version without logging authorization headers, credentials, provider payloads, or image bytes.

## Credential and environment boundary

Hosted provider secrets remain in Huabu's SecretStore or server-only provider configuration and are resolved only inside hosted services. Catalogue records, Profile records, durable workloads, prompts, and HTTP responses contain no secret values.

Before Huabu starts the Agentlet daemon, Agenetes strips the complete `HUABU_` namespace and an exact denylist of hosted-provider variables: `TAVILY_API_KEY`, `RAPIDAPI_KEY`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_ENDPOINT`, and `AZURE_OPENAI_API_DEPLOYMENT_NAME`. Huabu then explicitly injects only the RFS coordinates and runtime resource grant required by the external Agent. General external CLI credentials are not part of this hosted-capability denylist because command-backed ACP harnesses may require them.

## Agent Team boundary

Profile v2 applies to command-backed and manifest-backed Profiles, but Agent Resources do not replace Agent Team Setup. Manifests do not implicitly publish resource records, and preparation state, Config resolution, prepared workspaces, and runtime validation retain their existing behavior.

## Code entry points

| File/dir                                                                                                                                             | Responsibility                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`external/agenetes/packages/protocol/src/resource.ts`](../../external/agenetes/packages/protocol/src/resource.ts)                                   | Canonical resource and bounded resource-ID schemas.                                          |
| [`external/agenetes/packages/resource-registry/`](../../external/agenetes/packages/resource-registry/)                                               | Framework-independent registry and persistence.                                              |
| [`external/agenetes/packages/agent-team/`](../../external/agenetes/packages/agent-team/)                                                             | Profile v2, registry v4 migration, reference validation, and Profile snapshot compatibility. |
| [`external/agentlet/packages/resources/`](../../external/agentlet/packages/resources/)                                                               | Resource-root layout, receipt validation, and machine catalogue projection.                  |
| [`apps/server/src/modules/agent/acp/resources.ts`](../../apps/server/src/modules/agent/acp/resources.ts)                                             | Huabu records, required defaults, placement policy, and local-provider reconciliation.       |
| [`apps/server/src/modules/agent/hosted-capabilities/`](../../apps/server/src/modules/agent/hosted-capabilities/)                                     | Runtime grants and shared hosted services.                                                   |
| [`apps/server/src/modules/remote_fs/rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts)                                             | RFS discovery, local receipt management, and hosted invocation adapters.                     |
| [`apps/web/src/components/Settings/agent-team/ProfileResourceField.tsx`](../../apps/web/src/components/Settings/agent-team/ProfileResourceField.tsx) | Required, optional, and unresolved Profile resource selection.                               |
| [`packages/shared/src/types/api/agent-resource.ts`](../../packages/shared/src/types/api/agent-resource.ts)                                           | Huabu catalogue and local receipt wire contracts.                                            |
| [`packages/shared/src/types/api/hosted-capability.ts`](../../packages/shared/src/types/api/hosted-capability.ts)                                     | Hosted invocation inputs, grant headers, and environment constants.                          |
