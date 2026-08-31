# Local Resource Management

> Phase 1 machine-local resource infrastructure: the bounded directory layout
> Agentlet owns under `AGENT_RESOURCE_DIR`, the versioned receipt format used
> to record what is installed there, and the enumeration/projection service a
> host integration (Huabu's Agentlet provider) uses to surface those local
> resources through the Agenetes Resource Registry.
>
> For the full registry design, see
> [`docs/proposals/agent-resource-registry.md`](../../../docs/proposals/agent-resource-registry.md)
> §8 ("Local resource management"). This document is the Agentlet-side
> implementation contract; it does not define the Agenetes `AgentResource`
> catalogue, Profile resource selection, or hosted capability invocation.

## 1. `AGENT_RESOURCE_DIR`

Agentlet defines `AGENT_RESOURCE_DIR` for every spawned external agent through
its `envRegistry`, alongside `AGENTLET_REACHBACK_DIR`.

- Default: an absolute directory under the daemon user's home directory,
  `~/.agentlet/resources`, resolved with `os.homedir()` so it follows the
  platform convention (`$HOME` on POSIX, `USERPROFILE` on Windows).
- Override: an operator may set the `AGENT_RESOURCE_DIR` environment variable on the daemon process to an explicit absolute root. Relative overrides fail explicitly so a daemon restart from another working directory cannot silently point agents at a different resource store.

The physical root belongs to Agentlet, which knows the execution machine and
launches the process that consumes these files. The variable is computed once
per daemon process and injected identically into every spawned agent, so a
resource installed once is visible to every agent on that machine.

## 2. Directory layout

```text
$AGENT_RESOURCE_DIR/
  skills/       # cloned or installed Agent Skills
  tools/        # managed CLI packages and launch shims
  connectors/   # resource bundles such as HackMD publishing
  receipts/     # machine-owned installation and validation records
```

This is the complete, bounded set of subdirectories Agentlet creates and
scans. `ensureResourceLayout(root)` creates all four idempotently; nothing
outside this set is created or read by the resource infrastructure. Writing a
receipt (§3) ensures the layout exists as a side effect, so the directories
appear the first time a resource is actually installed rather than
unconditionally at every daemon start.

## 3. Receipts

A receipt is Agentlet's own installation and validation record for one Skill,
tool, or connector placed under `AGENT_RESOURCE_DIR`. It is distinct from —
and not a substitute for — the Agenetes `AgentResource` catalogue record; it
is the machine-local evidence the catalogue projection (§4) reads to decide
what actually exists on this machine.

```ts
interface ResourceReceipt {
  schemaVersion: 1;
  id: string; // stable, kebab-case, shared with the catalogue projection
  kind: 'skill' | 'tool' | 'connector';
  name: string;
  provider: string; // `huabu` or the exact Agentlet machine ID
  description: string;
  instructions: string; // never contains a secret value
  entrypoint: string; // path to the validated entrypoint, relative to AGENT_RESOURCE_DIR
  source?: string; // optional install provenance (URL, package spec, commit) — never a secret
  installedAt: string; // ISO-8601 timestamp
}
```

Persistence is a `<AGENT_RESOURCE_DIR>/receipts/<id>.json` file per resource.

- **Versioned**: `schemaVersion` must equal the current supported value.
  Reading or parsing a receipt with a missing or unsupported schema version
  fails explicitly — there is no best-effort coercion.
- **Atomic writes**: `writeReceipt` writes the full payload to a temporary
  file (`<id>.json.tmp`) in the same directory and then renames it over the
  final path, so a concurrent reader never observes a partially written
  receipt.
- **No arbitrary path traversal**: every receipt's `entrypoint` must exist and is validated by realpath to resolve strictly inside the resource root, so `..` traversal, escaping absolute paths, and symbolic-link escape are rejected before write and on every subsequent read. Receipt IDs are constrained to kebab-case and must match their receipt filenames.
- **Owner-only persistence**: receipt files use mode `0600` where the platform supports POSIX permissions.
- **Machine ownership**: host projection may require every receipt provider to equal the current Agentlet machine ID; mismatches produce sanitized diagnostics and are not published.
- **No secrets**: neither `instructions` nor `source` is a channel for
  credential material; this matches the catalogue's `instructions` contract
  in the registry proposal.

## 4. Local resource enumeration and catalogue projection

`enumerateLocalResources(root, expectedProvider?)` reads every `*.json` file directly under
`<root>/receipts`, validates each as a `ResourceReceipt`, and projects the
valid ones into a minimal record:

```ts
interface LocalResourceRecord {
  schemaVersion: 1;
  id: string;
  name: string;
  provider: string;
  description: string;
  instructions: string;
}
```

This mirrors the canonical Agenetes `AgentResource` shape field-for-field.
Agentlet has no build/workspace dependency on the Agenetes packages — they
live in a separate repository and pnpm workspace — so `LocalResourceRecord`
is a self-contained adapter type rather than an import of the Agenetes type.
A host integration (Huabu's Agentlet provider) maps `LocalResourceRecord`
onto its own `AgentResource` type one field at a time at that adapter
boundary; because the shapes already match, the mapping is a structural
no-op. This keeps the boundary explicit without requiring a cross-repository
dependency to be wired up as part of Phase 1.

Enumeration never reads outside `<root>/receipts`: it does not scan `root` itself, the `skills/`, `tools/`, or `connectors/` subdirectories, or any other machine path. An invalid or unreadable receipt produces a stable sanitized diagnostic rather than aborting the whole enumeration. Agentlet does not promote unvalidated installation claims into the catalogue; only a receipt whose entrypoint and optional expected provider pass validation is projected.

## 5. Scope of this implementation

Phase 1 delivers the infrastructure described above: `AGENT_RESOURCE_DIR`
provisioning, the bounded layout, receipt persistence and validation, and the
enumeration/projection service. It intentionally does not:

- register or withdraw records with an Agenetes Resource Registry — that
  wiring belongs to the host integration described in the registry proposal;
- install files itself — Huabu's Local Resource Management Skill requires the external harness permission flow before the Agent mutates the bounded root, then Huabu's RFS adapter calls this package to validate and persist the receipt and refresh the Agenetes provider projection;
- change Agent Team Setup, preparation, manifest resolution, or workspace
  materialization behavior in any way.

## 6. Source references

| Concern | Source |
| --- | --- |
| `AGENT_RESOURCE_DIR` resolution and bounded layout | [`packages/resources/src/resource-dir.ts`](../packages/resources/src/resource-dir.ts) |
| Receipt schema, validation, atomic writes | [`packages/resources/src/receipts.ts`](../packages/resources/src/receipts.ts) |
| Enumeration and catalogue projection | [`packages/resources/src/catalogue.ts`](../packages/resources/src/catalogue.ts) |
| Daemon env registry wiring | [`packages/local/src/agentlet.ts`](../packages/local/src/agentlet.ts) (`buildEnvRegistryDefaults`) |
