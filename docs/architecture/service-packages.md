# Service Packages

> Current architecture for Huabu-managed third-party services. Last updated: 2026-10-15

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

Server bundling copies the Service tree to `apps/server/dist-bundle/services/`. Desktop packaging includes that tree at `resources/server/services/`, alongside `server.js`, excluding `*.test.*` source files while retaining every `service.yaml` and its declared runtime Package files. The loader validates these files during module initialization, so missing resources prevent the local Server from starting even when no Service has been configured. The bundle runtime regression test verifies the desktop resource mapping, excludes test sources, and loads the packages from an isolated packaged layout without the source-tree fallback.

## Manifest contract

`huabu-service/v1` is defined by `serviceManifestSchema` in `packages/shared/src/types/api/service-package.ts`. Unknown properties, malformed IDs, duplicate configuration IDs, invalid enum declarations, ambiguous Package paths, duplicate Package files, and `entry.mjs` without `SKILL.md` fail validation.

Every package declares a stable ID and version, display metadata, one registered storage namespace, an exact `package.files` allowlist, and constrained configuration fields. `service.yaml` is included implicitly; every other distributable file must be listed as a portable ASCII Package-root-relative regular-file path using `/` separators. Directories, glob patterns, exclusions, symlinks, duplicate paths, platform-specific paths, and traversal are not supported. Supported configuration field types are text, secret, HTTPS URL, boolean, and bounded enum. `configuration[].id` directly names a stable logical key exposed by the namespace adapter; `label` is display text and can change without changing the storage or entry contract.

The manifest does not declare consumers. Internal Agent and Pipeline execution paths are reviewed Huabu code and cannot be enabled by package metadata. A root `SKILL.md` in `package.files` declares External Agent support; an optional root `entry.mjs` provides a directly executable and modifiable starting point. A Package without `SKILL.md` cannot be leased or downloaded through External RFS, and `entry.mjs` cannot be published without `SKILL.md`.

## Provision Service and storage bindings

`ServiceProvisioner` is the canonical access point for Generic Settings, Internal Agent tools, product pipelines, and External Agent leases. It validates field updates against the manifest, selects a code-registered namespace adapter, and exposes masked settings reads separately from trusted resolution.

Namespace IDs are opaque adapter keys rather than object paths:

| Package               | Namespace                       | Existing authoritative owner                                                           |
| --------------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| `image-gen`           | `llm.imageConfig`               | `llm-config.json` top-level `imageConfig` plus SecretStore `llm:image:api-key`         |
| `web-search`          | `integration.tavily`            | SecretStore `integration:tavily:api-key` with `TAVILY_API_KEY` fallback                |
| `hackmd`              | `integration.hackmd`            | SecretStore `integration:hackmd:api-key` with operator `HMD_API_ACCESS_TOKEN` fallback |
| `youtube-transcripts` | `integration.rapidapi`          | SecretStore `integration:rapidapi:api-key` with `RAPIDAPI_KEY` fallback                |
| `ink-ocr`             | `integration.azureVisionInkOcr` | Existing versioned Azure Vision record and its legacy/environment compatibility reads  |

This is a zero-persistent-data-migration compatibility layer. Reading Service status performs no write; saving delegates to the original owner; no second record is created; credentials are not copied, rewritten, or re-encrypted. The original owner retains validation, defaults, environment fallback, atomicity, rollback, and explicit-null semantics.

Masked Settings responses return `null` for secret values and identify configured fields separately. Trusted `resolveForServer()` and authenticated External leases resolve effective values, including environment fallbacks, only at the point of use.

## Execution paths

Internal Agent tools keep their high-level Huabu integrations. `generate_image` still owns typed tool arguments, model capability validation, reference artifact reads, provider SDK behavior, image decoding, and artifact persistence; it obtains provider configuration through `resolveForServer('image-gen')`.

Product pipelines also retain reviewed Server adapters. The YouTube loader and Ink OCR request path resolve their registered Service configuration but do not import Package entries.

External Agent Packages provide a real `SKILL.md` and may provide an `entry.mjs` that imports `HUABU_SERVICE_SDK_URL`, leases one coherent runtime context containing the current Manifest and configuration, and implements only a useful baseline provider workflow. Every executable entry supports `-h` and `--help`; an Agent runs help before invocation because runtime Manifest constraints and configured defaults may not be derivable from the source alone. Entries define their own CLI mapping, use Manifest enum options as the authoritative choices, use explicitly mapped configuration fields as defaults, and let an explicit operation argument override only those defaults. The entry is not a complete provider SDK: the Skill links official provider documentation, and an Agent may modify its downloaded local copy for additional endpoints. The bundled Image, Tavily, and HackMD Packages are Agent-facing. YouTube Transcripts and Ink OCR are not Agent-facing and therefore publish neither placeholder file.

## Owner Settings API

The HackMD Package replaces the retired publisher Team. Its entry uses the existing Service SDK and official HTTPS API for reading, creating and updating a specified note, without `hackmd-cli` or a package-local `.env`. New notes default to owner-only access and disabled comments; updates preserve permissions unless the caller explicitly requests a visibility change. The entry returns provider update acceptance separately from read-back verification and makes no automatic retries. Sharing, content selection, assembly and Space write-back belong to the calling Agent and require user authorization. There is no dedicated publisher Agent, sync daemon, team administration, delete operation, credential migration, or new Huabu HTTP endpoint.

The owner UI uses:

```text
GET /api/services
GET /api/services/:serviceId
PUT /api/services/:serviceId
```

Wire schemas live in `packages/shared/src/types/api/service-package.ts`. The Web app imports only their inferred types and renders `ServicesSettings` from the returned manifests. Existing service-specific endpoints remain compatible for non-migrated callers, but the Services tab uses only the generic API.

The Services UI localizes bundled service names, short descriptions, fields, and enum labels by stable service/field IDs using the existing Web i18n resources. Unknown services, fields, and options retain manifest text. Field IDs, option values, server validation, and persistence remain manifest-owned. Configured service headers omit success-status text; incomplete services show a muted Needs setup hint only while collapsed. Expanded services rely on their field-level credential controls, validation, and save feedback rather than duplicating configuration status in the header. Configuration completeness does not imply verified connectivity or service availability.

Services has no card-wide Save/Discard footer. Text and URL fields save on blur or Enter, not while typing; enum and boolean fields save immediately on selection. Required empty fields and non-HTTPS URLs remain local drafts with inline validation. Unchanged values do not write. If a required key is missing, ordinary edits remain local with an explicit waiting-for-key message; submitting the key validates required ordinary settings and sends them together, including staged optional edits. Secret fields reuse Settings/Common ApiKeyRow: the default view shows the shared credential status and Set/Update action rather than an empty password field with a configured placeholder. Keys require explicit submission, are never read back, and clear from the editor only after an acknowledged successful save. Removal is a separate explicit confirmation, not an empty-key save. Environment fallbacks remain storage-adapter-owned, so removing a stored key does not necessarily remove an environment-provided credential.

Per-service writes are serialized, duplicate in-flight field submissions are suppressed, and masked acknowledgements refresh status without overwriting unrelated drafts. Failed saves retain drafts and show inline errors with field retry or credential resubmission. Collapsing a service hides its previously mounted fields without losing drafts or feedback. Credential writes, including the entire secret-backed Ink OCR record, remain disabled while deployment readiness is unknown, failed, or read-only. Existing Generic Settings HTTP schemas and namespace adapters are unchanged.

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

## CLI Package discovery and download

The optional RFS CLI exposes `service list`, `service manifest ID`, `service skill ID` and `service download --out-folder FOLDER ID`, reusing the existing RFS endpoints above. HTTP-native and CLI root guides keep the same boundary: discover Services, read a Package Skill, download the Package, read its extracted `SKILL.md`, then load the focused Services guide. Entry execution, custom provider operations, leases, SDK use and credential lifecycle stay in the focused `services` presentation. `service --help` loads that CLI presentation; provider entry help remains a separate operation. The HTTP presentation includes a complete in-process lease example, while the CLI never prints or exports a lease.

Download saves and extracts the complete archive to `FOLDER/ID/`, not a flattened directory or a credentials file. It uses private staging and publishes only a validated complete extraction, refuses an existing target and uses an exclusive same-ID lock. Archive path confinement reuses existing filesystem helpers; links, special/encrypted entries, duplicate/case-colliding paths, wrong roots, invalid sizes/CRC and over-limit archives fail explicitly. Limits are 64 MiB compressed, 128 MiB expanded, 4096 entries and 4096 filesystem paths including implicit directories. Handled failures clean staging/lock; forced termination may leave artifacts requiring manual inspection. Success prints the final absolute directory. Download never executes Package code, obtains leases or stores configuration credentials. Agent-facing Package selection and provider execution boundaries are unchanged.

## Huabu client SDK

`packages/client-runtime` publishes the self-contained `dist/service-sdk.js`. Remote `huabu-daemon` and the embedded Server resolve the device-local artifact through the same resolver/bootstrap builder and inject its absolute `file://` URL as `HUABU_SERVICE_SDK_URL`. Generic Agentlet forwards and protects that opaque bootstrap key without owning SDK code. No old SDK alias or fallback is provided; previously downloaded entries must be refreshed and Agents restarted to obtain the new bootstrap. Node is selected by the Agent, not supplied or checked by the daemon. Without Node, the existing authenticated HTTP lease is still available to any HTTP-capable business process.

`leaseService(id)` obtains a fresh `{ id, version, manifest, config }` context without downloading or loading Package code. `withServiceContext(id, callback)` is the scoped convenience wrapper used by `entry.mjs`. The SDK validates the canonical shared `serviceLeaseSchema`, including identity/version coherence and declared config fields, reports bounded status-only request failures, and does not include malformed JSON or response bodies that could contain credentials.

The SDK reduces accidental persistence but is not a sandbox. A trusted External Agent and loaded client share the Agent process's filesystem, network, RFS bearer, and provider credentials. Static provider credentials cannot be revoked after disclosure except by provider-side rotation.

## Build and packaging

Server development reads Packages from `apps/server/src/services`. The Server bundle copies that directory to `dist-bundle/services`, while RFS distribution still selects only Manifest-declared files. Agentlet is bundled separately as `agentlet/index.js` with no SDK. The self-contained client runtime is copied into `dist-bundle/client-runtime`; Desktop resources include its JS files and explicit ESM `package.json`. Server build/bundle and development startup build the runtime. `pnpm start:daemon` builds Agentlet and the runtime before running the source launcher, without global PATH installation.

## Code entry points

| File                                                             | Responsibility                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/shared/src/types/api/service-package.ts`               | Manifest, Generic Settings, summary, and lease schemas                     |
| `apps/server/src/modules/services/package-loader.ts`             | Bundled YAML parsing, exact file validation, hashing, and path confinement |
| `apps/server/src/modules/services/provisioner.ts`                | Namespace adapters and trusted/masked projections                          |
| `apps/server/src/modules/services/services.route.ts`             | Owner Generic Settings API                                                 |
| `apps/server/src/modules/remote_fs/rfs.route.ts`                 | Authenticated Service discovery, files, and lease                          |
| `apps/web/src/components/Settings/sections/ServicesSettings.tsx` | Manifest-driven Services UI                                                |
| `packages/client-runtime/src/service-sdk.ts`                     | Canonical lease-only External Agent SDK                                    |
| `packages/client-runtime/src/bootstrap.ts`                       | Shared device-local artifacts and host bootstrap                           |
| `packages/client-runtime/src/daemon.ts`                          | Source-checkout launcher and connection env inputs                         |
| `packages/client-runtime/src/rfs-service.ts`                     | Staged Service ZIP validation and extraction                               |
