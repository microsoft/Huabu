# Capability Packages

> Current architecture for Huabu-managed provider capabilities. Last updated: 2026-10-09

## Scope

Capability Packages make provider configuration declarative without forcing Internal Agent tools, product pipelines, and External Agents through one execution path. The package is the source of truth for Settings fields and Agent-facing files; reviewed Huabu code remains the source of truth for Server execution.

The bundled packages live under `apps/server/src/capabilities/<id>/`:

```text
<capability>/
├── capability.yaml
├── SKILL.md           # required only when External Agent-facing
└── client.mjs         # required only for a direct Agent-side provider call
```

Phase 1 packages are trusted files shipped with Huabu. User upload, installation, remote registries, and Server execution of uploaded code are not supported.

## Manifest contract

`huabu-capability/v1` is defined by `capabilityManifestSchema` in `packages/shared/src/types/api/capability-package.ts`. Unknown properties, malformed IDs, duplicate configuration IDs, invalid enum declarations, and an External consumer without a Skill fail validation.

Every package declares a stable ID and version, display metadata, one registered storage namespace, supported consumer classes, optional Agent files, and constrained configuration fields. Supported field types are text, secret, HTTPS URL, boolean, and bounded enum. `configuration[].id` directly names a stable logical key exposed by the namespace adapter; `label` is display text and can change without changing the storage or client contract.

The manifest cannot register Server tools, choose arbitrary persistence paths or SecretStore IDs, provide custom Settings components, or execute expressions. Agent files are forbidden when `consumers.external` is false, so a Server-only or Pipeline-only package cannot accidentally advertise placeholder Agent behavior.

## Provision Service and storage bindings

`CapabilityProvisionService` is the canonical access point for Generic Settings, Internal Agent tools, product pipelines, and External Agent leases. It validates field updates against the manifest, selects a code-registered namespace adapter, and exposes masked settings reads separately from trusted resolution.

Namespace IDs are opaque adapter keys rather than object paths:

| Package               | Namespace                       | Existing authoritative owner                                                          |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `image-gen`           | `llm.imageConfig`               | `llm-config.json` top-level `imageConfig` plus SecretStore `llm:image:api-key`        |
| `web-search`          | `integration.tavily`            | SecretStore `integration:tavily:api-key` with `TAVILY_API_KEY` fallback               |
| `youtube-transcripts` | `integration.rapidapi`          | SecretStore `integration:rapidapi:api-key` with `RAPIDAPI_KEY` fallback               |
| `ink-ocr`             | `integration.azureVisionInkOcr` | Existing versioned Azure Vision record and its legacy/environment compatibility reads |

This is a zero-persistent-data-migration compatibility layer. Reading Capability status performs no write; saving delegates to the original owner; no second record is created; credentials are not copied, rewritten, or re-encrypted. The original owner retains validation, defaults, environment fallback, atomicity, rollback, and explicit-null semantics.

Masked Settings responses return `null` for secret values and identify configured fields separately. Trusted `resolveForServer()` and authenticated External leases resolve effective values, including environment fallbacks, only at the point of use.

## Consumers

Internal Agent tools keep their high-level Huabu integrations. `generate_image` still owns typed tool arguments, model capability validation, reference artifact reads, provider SDK behavior, image decoding, and artifact persistence; it obtains provider configuration through `resolveForServer('image-gen')`.

Product pipelines also retain reviewed Server adapters. The YouTube loader and Ink OCR request path resolve their registered Capability configuration but do not import package `client.mjs`.

External Agent packages provide a real `SKILL.md` and, when direct provider execution is needed, a `client.mjs` exporting `createClient({ config })`. The bundled Image and Tavily packages are Agent-facing. YouTube Transcripts and Ink OCR are not Agent-facing and therefore ship neither placeholder file.

## Owner Settings API

The owner UI uses:

```text
GET /api/capabilities
GET /api/capabilities/:capabilityId
PUT /api/capabilities/:capabilityId
```

Wire schemas live in `packages/shared/src/types/api/capability-package.ts`. The Web app imports only their inferred types and renders `CapabilitiesSettings` from the returned manifests. Existing capability-specific endpoints remain compatible for non-migrated callers, but the Capabilities tab uses only the generic API.

## External Agent RFS API

The canvas-scoped RFS already reserves `/capabilities` for direct Space-operation discovery, so provider packages use the unambiguous `/capability-packages` resource:

```text
GET  /capability-packages
GET  /capability-packages/:id/manifest
GET  /capability-packages/:id/skill
GET  /capability-packages/:id/client
POST /capability-packages/:id/lease
```

Manifest and Skill responses contain no credentials. Client source is a versioned bundled asset. Lease requires the normal authenticated RFS context, rejects unknown, unconfigured, and non-External packages explicitly, returns only fields declared by the selected package, and uses `Cache-Control: no-store`.

## Agentlet SDK

Agentlet publishes `dist/capability-sdk/index.js`. The daemon computes its absolute `file://` URL relative to its own `import.meta.url` and injects it as the authoritative `AGENTLET_CAPABILITY_SDK_URL` after workload environment values, so a Profile or session cannot replace it.

`loadCapability(id)` obtains a fresh lease and loads the trusted package client from Huabu without writing credentials to disk. `withCapability(id, callback)` is the convenience wrapper. The SDK reports bounded status-only request failures and does not include response bodies that could contain credentials.

The SDK reduces accidental persistence but is not a sandbox. A trusted External Agent and loaded client share the Agent process's filesystem, network, RFS bearer, and provider credentials. Static provider credentials cannot be revoked after disclosure except by provider-side rotation.

## Build and packaging

Server development reads packages from `apps/server/src/capabilities`. The Server bundle copies that directory to `dist-bundle/capabilities`. The bundled Agentlet build emits both `agentlet/index.js` and `agentlet/capability-sdk/index.js`; the published Agentlet npm package already includes its complete `dist` tree.

## Code entry points

| File                                                                 | Responsibility                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/shared/src/types/api/capability-package.ts`                | Manifest, Generic Settings, summary, and lease schemas |
| `apps/server/src/modules/capabilities/package-loader.ts`             | Bundled YAML parsing, validation, and path confinement |
| `apps/server/src/modules/capabilities/provision-service.ts`          | Namespace adapters and trusted/masked projections      |
| `apps/server/src/modules/capabilities/capabilities.route.ts`         | Owner Generic Settings API                             |
| `apps/server/src/modules/remote_fs/rfs.route.ts`                     | Authenticated package discovery, files, and lease      |
| `apps/web/src/components/Settings/sections/CapabilitiesSettings.tsx` | Manifest-driven Capabilities UI                        |
| `external/agentlet/packages/local/src/capability-sdk/index.ts`       | External Agent SDK                                     |
