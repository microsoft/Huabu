# Credential storage — deferred hardening follow-ups

Status: Draft
Last updated: 2026-07-27

## Context

The 2026-07 credential-hardening pass fixed the fail-closed reads, OAuth logout truthfulness, and cross-write compensation in the credential subsystem ([`apps/server/src/security/`](../../apps/server/src/security/), [`apps/desktop/src/secure-secrets.ts`](../../apps/desktop/src/secure-secrets.ts)).

Three items were **intentionally deferred** — each is correct-in-theory but low ROI right now. A fourth was added later, when deleting the desktop half of the plaintext migration raised the question of whether the server half should follow. This doc keeps them visible and, more importantly, records the _trigger_ that should promote each from "deferred" to "do it", so we neither forget them nor do them prematurely.

## 1. Desktop bridge batch write is not atomic — LOW

`ElectronSecretStore.setMany` ([`desktop-secret-bridge.ts`](../../apps/server/src/security/desktop-secret-bridge.ts)) writes one key per IPC round-trip, so a mid-batch failure can leave an earlier key committed. The encrypted-file backend (`EncryptedFileSecretStore.setMany`) already replaces the file atomically; only the Electron path degrades.

Why deferred: the sole multi-secret caller is `setIntegrationsConfig` (Tavily + RapidAPI). Those keys are independent and the write is idempotent, so a partial commit is self-healing on retry — not data loss, not a security issue, and a narrow failure window.

Full fix: add a `secret:mutateMany` IPC message; Electron main builds the full `entries` map and calls `DesktopSecureSecretStore.setMany` for a single atomic file replacement.

**Promote when** any of: (a) a new multi-secret write whose keys are _coupled_ (one changes → the other must, or logic breaks); (b) a non-retryable / non-idempotent batch write; (c) a real user report of a desktop partial-commit.

## 2. Missing "config write + rollback both fail" test for `setLLMConfig` — LOW

`setLLMConfig` ([`llm.ts`](../../apps/server/src/modules/agent/llm.ts)) rolls back the api-key secret when the plain-config write fails, and logs + throws a partial-commit error when the rollback _also_ fails. The double-failure path has no unit test.

Why deferred: `savePersistedStore` → `writeFileSync` plus the module-level pino logger (also fs-backed) mean a global `node:fs` mock breaks the logger, so a clean test needs a refactor first.

Full fix: extract `savePersistedStore` (and the config read) into an injectable seam, then test both "config write fails → key restored" and "config write + rollback both fail → partial-commit error + log". Tracked as `it.todo` in [`llm.settings.test.ts`](../../apps/server/src/modules/agent/llm.settings.test.ts).

## 3. De-duplicate the secret-id contract — MEDIUM (highest anti-drift value)

Secret-id constants, the provider-id regex, and the accept/reject decision are duplicated across [`secret-ids.ts`](../../apps/server/src/security/secret-ids.ts) and [`secure-secrets.ts`](../../apps/desktop/src/secure-secrets.ts).

The collect/scrub migration rules used to be duplicated as well and had drifted three ways (azure precedence, fsync discipline, fail-open reads). That copy is gone: Electron's plaintext migration was deleted once release history showed no shipped desktop version had ever written plaintext credentials. Two of those three drifts disappeared with it; the third (fail-open vs fail-closed JSON reads) now only affects the vault-read path.

The dangerous class that remains is **id drift**: desktop encrypts under one id string while the server reads another → the key silently "disappears", the hardest failure to trace.

This has since happened in production: the Codex OAuth id was added to the server but not to the desktop whitelist, so every Codex login failed with `Credential store modify failed for openai-codex` ([microsoft/Huabu#40](https://github.com/microsoft/Huabu/issues/40)). A parity test in [`secure-secrets.test.ts`](../../apps/desktop/src/secure-secrets.test.ts) now fails the desktop test run when the two id sets, the provider-id derivation, or the accept/reject decisions diverge, and CI runs that suite explicitly. That is a drift _detector_, not a drift _eliminator_ — the extraction below is still the real fix.

Full fix: extract the pure contract — id constants, regex, `llmProviderApiKeySecretId`, `isSecretId` — into a **zero-dependency subpath** of `@sediment/shared` (e.g. `@sediment/shared/security`), imported by both apps.

Constraints (why it isn't just "share everything"): `@sediment/shared` is isomorphic (imported by web, zero node deps) → **no `fs` code may live there**. The two encrypted stores must **stay separate** (safeStorage opaque blob vs explicit AES-GCM formats differ). `apps/desktop` currently depends on neither `shared` nor `server`, and is compiled by plain `tsc` with no bundler, so consuming the raw-TypeScript `@sediment/shared` requires giving the desktop package a bundler first — that is the real cost.

**Promote when** touching this subsystem again for any reason — fold the extraction into that change rather than adding a fourth hand-synced copy.

## 4. Sunset the standalone plaintext migration — LOW

[`plaintext-secret-migration.ts`](../../apps/server/src/security/plaintext-secret-migration.ts) still encrypts and scrubs legacy plaintext credentials on standalone startup, and [`secret-store.ts`](../../apps/server/src/security/secret-store.ts) refuses to boot when it detects them without a master key. Both only ever fire on data directories written before 2026-07-10; no shipped release and no container image ever produced such a directory, so the realistic population is a handful of local developer `data/` folders.

Why deferred: it is now the **only** lifecycle handler for `integrations.json` and `oauth-credentials.json`. Nothing else in the codebase reads or writes those two files, so deleting the migration would leave a Tavily key, a RapidAPI key, and a Copilot refresh token sitting in cleartext on disk permanently — unread, unscrubbed, and unreported. `llm-config.json` does not have this problem: it is scrubbed on both the read and write boundary, so its legacy `apiKey` disappears on the next Settings save. Keeping the migration also costs nothing in drift risk now that the desktop copy is gone and this is the single implementation.

Full fix (when we do decide to stop cleaning up pre-0.9 plaintext): do **not** delete silently. Split the detection out of the migration into a cheap field-presence check that does not depend on the `collect*` helpers, change the startup error to name the offending files and tell the operator to delete the fields and re-enter the credentials in Settings, and only then remove `migratePlaintextCredentials` and the three collectors. The startup gate is a security policy, not a migration step, and must outlive the migration.

**Promote when** the migration's presence starts costing something concrete — e.g. it blocks a refactor of the secret-store initialization order, or a credential file format changes and the collectors would need updating to match.

## Not doing

- Unifying the two encrypted stores into one abstraction (formats + crypto genuinely differ — a leaky abstraction).
- Putting fs-backed migration code into `@sediment/shared` (would pollute the web bundle).
