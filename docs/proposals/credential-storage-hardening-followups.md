# Credential storage — deferred hardening follow-ups

Status: Draft
Last updated: 2026-07-27

## Context

The 2026-07 credential-hardening pass fixed the fail-closed reads, OAuth logout truthfulness, and cross-write compensation in the credential subsystem ([`apps/server/src/security/`](../../apps/server/src/security/), [`apps/desktop/src/secure-secrets.ts`](../../apps/desktop/src/secure-secrets.ts)).

Three items were **intentionally deferred** — each is correct-in-theory but low ROI right now. This doc keeps them visible and, more importantly, records the _trigger_ that should promote each from "deferred" to "do it", so we neither forget them nor do them prematurely.

## 1. Desktop bridge batch write is not atomic — LOW

`ElectronSecretStore.setMany` ([`desktop-secret-bridge.ts`](../../apps/server/src/security/desktop-secret-bridge.ts)) writes one key per IPC round-trip, so a mid-batch failure can leave an earlier key committed. The encrypted-file backend (`EncryptedFileSecretStore.setMany`) already replaces the file atomically; only the Electron path degrades.

Why deferred: the sole multi-secret caller is `setIntegrationsConfig` (Tavily + RapidAPI). Those keys are independent and the write is idempotent, so a partial commit is self-healing on retry — not data loss, not a security issue, and a narrow failure window.

Full fix: add a `secret:mutateMany` IPC message; Electron main builds the full `entries` map and hands it to a new `DesktopSecureSecretStore.setMany` for a single atomic file replacement.

**Promote when** any of: (a) a new multi-secret write whose keys are _coupled_ (one changes → the other must, or logic breaks); (b) a non-retryable / non-idempotent batch write; (c) a real user report of a desktop partial-commit.

## 2. Missing "config write + rollback both fail" test for `setLLMConfig` — LOW

`setLLMConfig` ([`llm.ts`](../../apps/server/src/modules/agent/llm.ts)) rolls back the api-key secret when the plain-config write fails, and logs + throws a partial-commit error when the rollback _also_ fails. The double-failure path has no unit test.

Why deferred: `savePersistedStore` → `writeFileSync` plus the module-level pino logger (also fs-backed) mean a global `node:fs` mock breaks the logger, so a clean test needs a refactor first.

Full fix: extract `savePersistedStore` (and the config read) into an injectable seam, then test both "config write fails → key restored" and "config write + rollback both fail → partial-commit error + log". Tracked as `it.todo` in [`llm.settings.test.ts`](../../apps/server/src/modules/agent/llm.settings.test.ts).

## 3. De-duplicate the secret-id contract — RESOLVED BY DESIGN CHANGE

Originally: secret-id constants and the provider-id regex were duplicated across [`secret-ids.ts`](../../apps/server/src/security/secret-ids.ts) and [`secure-secrets.ts`](../../apps/desktop/src/secure-secrets.ts), and the dangerous class was **id drift** — desktop rejects an id the server writes, so the credential silently never persists. That happened in production: the Codex OAuth id was added to the server but not to the desktop whitelist, and every Codex login failed with `Credential store modify failed for openai-codex` ([microsoft/Huabu#40](https://github.com/microsoft/Huabu/issues/40)).

The duplication was never load-bearing on its own. It existed because the original `safeStorage` change put the plaintext-credential migration inside Electron main, which had to _generate_ ids and therefore needed the full set as values. Once that migration was deleted, desktop stopped producing ids and only validated them — but the list stayed.

Resolution: `isDesktopSecretId` now matches by **shape** instead of enumerating the server's ids. Since the server process already holds every decrypted secret from the `secret:init` snapshot, an exact list added no confidentiality — only vault hygiene, which shape validation preserves. The server's `llmProviderApiKeySecretId` generator asserts the same provider-segment character and length invariant before producing an id, while Electron applies the bounded shape defensively at the IPC boundary. Nothing needs syncing between the two packages any more, so the routine secret-id drift class is eliminated rather than merely detected. See [`credential-storage.md`](../architecture/credential-storage.md).

Residual: adding a _new namespace_ (beyond `llm` / `integration` / `oauth`) still requires a desktop change. That is an explicit architectural step rather than something a routine secret addition can silently miss.

Extraction into a zero-dependency `@huabu/shared/security` subpath is no longer motivated by drift risk. Should it ever be revisited, the constraints still hold: `@huabu/shared` is isomorphic (imported by web, zero node deps) → **no `fs` code may live there**; the two encrypted stores must **stay separate** (safeStorage opaque blob vs explicit AES-GCM formats differ); and `apps/desktop` is compiled by plain `tsc` with no bundler, so consuming the raw-TypeScript package requires giving it a bundler first.

## Not doing

- Unifying the two encrypted stores into one abstraction (formats + crypto genuinely differ — a leaky abstraction).
