# Service Packages

> Current architecture for Huabu-managed third-party services. Last updated: 2026-10-10

## Scope

Service Packages make provider configuration declarative without forcing Internal Agent tools, product pipelines, and External Agents through one execution path. The package is the source of truth for Settings fields and Agent-facing files; reviewed Huabu code remains the source of truth for Server execution.

The bundled packages live under `apps/server/src/services/<id>/`:

```text
<service>/
├── service.yaml
├── SKILL.md           # required only when External Agent-facing
└── entry.mjs          # optional executable and modifiable starting point
```

Phase 1 packages are trusted files shipped with Huabu. User upload, installation, remote registries, and Server execution of uploaded code are not supported.

## Manifest contract

`huabu-service/v1` is defined by `serviceManifestSchema` in `packages/shared/src/types/api/service-package.ts`. Unknown properties, malformed IDs, duplicate configuration IDs, invalid enum declarations, ambiguous Package paths, duplicate Package files, and `entry.mjs` without `SKILL.md` fail validation.

Every package declares a stable ID and version, display metadata, one registered storage namespace, an exact `package.files` allowlist, and constrained configuration fields. `service.yaml` is included implicitly; every other distributable file must be listed as a portable ASCII Package-root-relative regular-file path using `/` separators. Directories, glob patterns, exclusions, symlinks, duplicate paths, platform-specific paths, and traversal are not supported. Supported configuration field types are text, secret, HTTPS URL, boolean, and bounded enum. `configuration[].id` directly names a stable logical key exposed by the namespace adapter; `label` is display text and can change without changing the storage or entry contract.

The manifest does not declare consumers. Internal Agent and Pipeline execution paths are reviewed Huabu code and cannot be enabled by package metadata. A root `SKILL.md` in `package.files` declares External Agent support; an optional root `entry.mjs` provides a directly executable and modifiable starting point. A Package without `SKILL.md` cannot be leased or downloaded through External RFS, and `entry.mjs` cannot be published without `SKILL.md`.

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

Product pipelines also retain reviewed Server adapters. The YouTube loader and Ink OCR request path resolve their registered Service configuration but do not import Package entries.

External Agent Packages provide a real `SKILL.md` and may provide an `entry.mjs` that imports `AGENTLET_SERVICE_SDK_URL`, leases one coherent runtime context containing the current Manifest and configuration, and implements only a useful baseline provider workflow. Every executable entry supports `-h` and `--help`; an Agent runs help before invocation because runtime Manifest constraints and configured defaults may not be derivable from the source alone. Entries define their own CLI mapping, use Manifest enum options as the authoritative choices, use explicitly mapped configuration fields as defaults, and let an explicit operation argument override only those defaults. The entry is not a complete provider SDK: the Skill links official provider documentation, and an Agent may modify its downloaded local copy for additional endpoints. The bundled Image and Tavily Packages are Agent-facing. YouTube Transcripts and Ink OCR are not Agent-facing and therefore publish neither placeholder file.

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
POST /services/:id/lease
GET  /download/services/:id.zip
```

Manifest and Skill responses contain no credentials. Lease requires the normal authenticated RFS context, rejects unknown, unconfigured, and Packages without `SKILL.md` explicitly, returns the exact validated Manifest together with only configuration fields declared by that Package, and uses `Cache-Control: no-store`. Returning both in one response keeps runtime choices, defaults, and Package version coherent.

Package download streams a ZIP on demand from the validated Package record without a temporary file or ZIP cache. The archive contains one `<serviceId>/` root directory, `service.yaml`, and exactly the files declared by `package.files`; undeclared tests and development files are excluded. The response uses the Package content hash as its ETag. Phase 1 resolves records from bundled directories; a future validated custom-Service installation can expose the same immutable root, exact file list, and hash without changing the route.

## Agentlet SDK

Agentlet publishes `dist/service-sdk/index.js`. The daemon computes its absolute `file://` URL relative to its own `import.meta.url` and injects it as the authoritative `AGENTLET_SERVICE_SDK_URL` after workload environment values, so a Profile or session cannot replace it.

`leaseService(id)` obtains a fresh `{ id, version, manifest, config }` context without downloading or loading Package code. `withServiceContext(id, callback)` is the scoped convenience wrapper used by `entry.mjs`. The SDK verifies that the leased Manifest identity and version match the enclosing context, reports bounded status-only request failures, and does not include response bodies that could contain credentials.

The SDK reduces accidental persistence but is not a sandbox. A trusted External Agent and loaded client share the Agent process's filesystem, network, RFS bearer, and provider credentials. Static provider credentials cannot be revoked after disclosure except by provider-side rotation.

## Build and packaging

Server development reads Packages from `apps/server/src/services`. The Server bundle copies that directory to `dist-bundle/services`, while RFS distribution still selects only Manifest-declared files. The bundled Agentlet build emits both `agentlet/index.js` and `agentlet/service-sdk/index.js`; the published Agentlet npm package already includes its complete `dist` tree.

## Code entry points

| File                                                             | Responsibility                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/shared/src/types/api/service-package.ts`               | Manifest, Generic Settings, summary, and lease schemas                     |
| `apps/server/src/modules/services/package-loader.ts`             | Bundled YAML parsing, exact file validation, hashing, and path confinement |
| `apps/server/src/modules/services/provisioner.ts`                | Namespace adapters and trusted/masked projections                          |
| `apps/server/src/modules/services/services.route.ts`             | Owner Generic Settings API                                                 |
| `apps/server/src/modules/remote_fs/rfs.route.ts`                 | Authenticated Service discovery, files, and lease                          |
| `apps/web/src/components/Settings/sections/ServicesSettings.tsx` | Manifest-driven Services UI                                                |
| `external/agentlet/packages/local/src/service-sdk/index.ts`      | External Agent SDK                                                         |
