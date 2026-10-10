# Service Packages

> Current architecture for Huabu-managed third-party services. Last updated: 2026-10-10

## Scope

Service Packages make provider configuration declarative without forcing Internal Agent tools, product pipelines, and External Agents through one execution path. The package is the source of truth for Settings fields and Agent-facing files; reviewed Huabu code remains the source of truth for Server execution.

The bundled packages live under `apps/server/src/services/<id>/`:

```text
<service>/
├── service.yaml
├── SKILL.md           # required only when External Agent-facing
└── client.mjs         # required only for a direct Agent-side provider call
```

Phase 1 packages are trusted files shipped with Huabu. User upload, installation, remote registries, and Server execution of uploaded code are not supported.

## Manifest contract

`huabu-service/v1` is defined by `serviceManifestSchema` in `packages/shared/src/types/api/service-package.ts`. Unknown properties, malformed IDs, duplicate configuration IDs, invalid enum declarations, and an `agent` block without a Skill fail validation.

Every package declares a stable ID and version, display metadata, one registered storage namespace, optional Agent files, and constrained configuration fields. Supported field types are text, secret, HTTPS URL, boolean, and bounded enum. `configuration[].id` directly names a stable logical key exposed by the namespace adapter; `label` is display text and can change without changing the storage or client contract.

The manifest does not declare Internal Agent or Pipeline consumers. Those execution paths are reviewed Huabu code and cannot be enabled by package metadata. The presence of an `agent` block is the complete declaration that a package supports External Agent use; its `skill` is required and its direct-provider `client` is optional. A package without `agent` cannot be leased to an External Agent.

## Provision Service and storage bindings

`ServiceProvisioner` is the canonical access point for Generic Settings, Internal Agent tools, product pipelines, and External Agent leases. It validates field updates against the manifest, selects a code-registered namespace adapter, and exposes masked settings reads separately from trusted resolution.

Namespace IDs are opaque adapter keys rather than object paths:

| Package               | Namespace                       | Existing authoritative owner                                                          |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `image-gen`           | `llm.imageConfig`               | `llm-config.json` top-level `imageConfig` plus SecretStore `llm:image:api-key`        |
| `web-search`          | `integration.tavily`            | SecretStore `integration:tavily:api-key` with `TAVILY_API_KEY` fallback               |
| `youtube-transcripts` | `integration.rapidapi`          | SecretStore `integration:rapidapi:api-key` with `RAPIDAPI_KEY` fallback               |
| `ink-ocr`             | `integration.azureVisionInkOcr` | Existing versioned Azure Vision record and its legacy/environment compatibility reads |

This is a zero-persistent-data-migration compatibility layer. Reading Service status performs no write; saving delegates to the original owner; no second record is created; credentials are not copied, rewritten, or re-encrypted. The original owner retains validation, defaults, environment fallback, atomicity, rollback, and explicit-null semantics.

Masked Settings responses return `null` for secret values and identify configured fields separately. Trusted `resolveForServer()` and authenticated External leases resolve effective values, including environment fallbacks, only at the point of use.

## Execution paths

Internal Agent tools keep their high-level Huabu integrations. `generate_image` still owns typed tool arguments, model capability validation, reference artifact reads, provider SDK behavior, image decoding, and artifact persistence; it obtains provider configuration through `resolveForServer('image-gen')`.

Product pipelines also retain reviewed Server adapters. The YouTube loader and Ink OCR request path resolve their registered Service configuration but do not import package `client.mjs`.

External Agent packages provide a real `SKILL.md` and, when direct provider execution is needed, a `client.mjs` exporting `createClient({ config })`. The bundled Image and Tavily packages are Agent-facing. YouTube Transcripts and Ink OCR are not Agent-facing and therefore ship neither placeholder file.

## Owner Settings API

The owner UI uses:

```text
GET /api/services
GET /api/services/:serviceId
PUT /api/services/:serviceId
```

Wire schemas live in `packages/shared/src/types/api/service-package.ts`. The Web app imports only their inferred types and renders `ServicesSettings` from the returned manifests. Existing service-specific endpoints remain compatible for non-migrated callers, but the Services tab uses only the generic API.

## External Agent RFS API

The canvas-scoped RFS retains `/capabilities` for direct Space-operation discovery and exposes configured third-party services through a separate `/services` resource:

```text
GET  /services
GET  /services/:id/manifest
GET  /services/:id/skill
GET  /services/:id/client
POST /services/:id/lease
```

Manifest and Skill responses contain no credentials. Client source is a versioned bundled asset. Lease requires the normal authenticated RFS context, rejects unknown, unconfigured, and packages without an `agent` declaration explicitly, returns only fields declared by the selected package, and uses `Cache-Control: no-store`.

## Agentlet SDK

Agentlet publishes `dist/service-sdk/index.js`. The daemon computes its absolute `file://` URL relative to its own `import.meta.url` and injects it as the authoritative `AGENTLET_SERVICE_SDK_URL` after workload environment values, so a Profile or session cannot replace it.

`loadService(id)` obtains a fresh lease and loads the trusted package client from Huabu without writing credentials to disk. `withService(id, callback)` is the convenience wrapper. The SDK reports bounded status-only request failures and does not include response bodies that could contain credentials.

The SDK reduces accidental persistence but is not a sandbox. A trusted External Agent and loaded client share the Agent process's filesystem, network, RFS bearer, and provider credentials. Static provider credentials cannot be revoked after disclosure except by provider-side rotation.

## Build and packaging

Server development reads packages from `apps/server/src/services`. The Server bundle copies that directory to `dist-bundle/services`. The bundled Agentlet build emits both `agentlet/index.js` and `agentlet/service-sdk/index.js`; the published Agentlet npm package already includes its complete `dist` tree.

## Code entry points

| File                                                             | Responsibility                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/shared/src/types/api/service-package.ts`               | Manifest, Generic Settings, summary, and lease schemas |
| `apps/server/src/modules/services/package-loader.ts`             | Bundled YAML parsing, validation, and path confinement |
| `apps/server/src/modules/services/provisioner.ts`                | Namespace adapters and trusted/masked projections      |
| `apps/server/src/modules/services/services.route.ts`             | Owner Generic Settings API                             |
| `apps/server/src/modules/remote_fs/rfs.route.ts`                 | Authenticated Service discovery, files, and lease      |
| `apps/web/src/components/Settings/sections/ServicesSettings.tsx` | Manifest-driven Services UI                            |
| `external/agentlet/packages/local/src/service-sdk/index.ts`      | External Agent SDK                                     |
