# Credential storage — deferred hardening follow-ups

Status: Draft
Last updated: 2026-07-10

## Context

The 2026-07 credential-hardening pass fixed the fail-closed reads, OAuth logout truthfulness, and cross-write compensation in the credential subsystem ([`apps/server/src/security/`](../../apps/server/src/security/), [`apps/desktop/src/secure-secrets.ts`](../../apps/desktop/src/secure-secrets.ts)).

Three items were **intentionally deferred** — each is correct-in-theory but low ROI right now. This doc keeps them visible and, more importantly, records the _trigger_ that should promote each from "deferred" to "do it", so we neither forget them nor do them prematurely.

## 1. Desktop bridge batch write is not atomic — LOW

`ElectronSecretStore.setMany` ([`desktop-secret-bridge.ts`](../../apps/server/src/security/desktop-secret-bridge.ts)) writes one key per IPC round-trip, so a mid-batch failure can leave an earlier key committed. The encrypted-file backend (`EncryptedFileSecretStore.setMany`) already replaces the file atomically; only the Electron path degrades.

Why deferred: the sole multi-secret caller is `setIntegrationsConfig` (Tavily + RapidAPI). Those keys are independent and the write is idempotent, so a partial commit is self-healing on retry — not data loss, not a security issue, and a narrow failure window.

Full fix: add a `secret:mutateMany` IPC message; Electron main builds the full `entries` map and calls `DesktopSecureSecretStore.setMany` for a single atomic file replacement.

**Promote when** any of: (a) a new multi-secret write whose keys are _coupled_ (one changes → the other must, or logic breaks); (b) a non-retryable / non-idempotent batch write; (c) a real user report of a desktop partial-commit.

## 2. Missing "config write + rollback both fail" test for `setLLMConfig` — LOW

`setLLMConfig` ([`llm.ts`](../../apps/server/src/modules/agent/llm.ts)) rolls back the api-key secret when the plain-config write fails, and logs + throws a partial-commit error when the rollback _also_ fails. The double-failure path has no unit test.

Why deferred: `savePersistedStore` → `writeFileSync` plus the module-level pino logger (also fs-backed) mean a global `node:fs` mock breaks the logger, so a clean test needs a refactor first.

Full fix: extract `savePersistedStore` (and the config read) into an injectable seam, then test both "config write fails → key restored" and "config write + rollback both fail → partial-commit error + log". Tracked as `it.todo` in [`llm.settings.test.ts`](../../apps/server/src/modules/agent/llm.settings.test.ts).

## 3. De-duplicate the secret-id contract + migration rules — MEDIUM (highest anti-drift value)

Secret-id constants, the provider-id regex, id generators, and the collect/scrub migration logic are duplicated across [`secret-ids.ts`](../../apps/server/src/security/secret-ids.ts) + [`plaintext-secret-migration.ts`](../../apps/server/src/security/plaintext-secret-migration.ts) and [`secure-secrets.ts`](../../apps/desktop/src/secure-secrets.ts). They have already drifted three times (azure guard, fsync discipline, fail-open reads).

The dangerous class is **id drift**: desktop encrypts under one id string while the server reads another → the key silently "disappears", the hardest failure to trace.

Full fix: extract the pure contract — id constants, regex, `llmProviderApiKeySecretId`, `isSecretId`, and a pure `planMigration(parsedJson)` with the azure rule expressed as data — into a **zero-dependency subpath** of `@sediment/shared` (e.g. `@sediment/shared/security`), imported by both apps.

Constraints (why it isn't just "share everything"): `@sediment/shared` is isomorphic (imported by web, zero node deps) → **no `fs` code may live there**. The two encrypted stores must **stay separate** (safeStorage opaque blob vs explicit AES-GCM formats differ). `apps/desktop` currently depends on neither `shared` nor `server`, so adding a `@sediment/shared` dependency (subpath only) is the real cost.

**Promote when** touching this subsystem again for any reason — fold the extraction into that change rather than adding a fourth hand-synced copy.

## Not doing

- Unifying the two encrypted stores into one abstraction (formats + crypto genuinely differ — a leaky abstraction).
- Putting fs-backed migration code into `@sediment/shared` (would pollute the web bundle).
