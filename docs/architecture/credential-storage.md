# Credential Storage

> Credential persistence for Electron and standalone server deployments. Last updated: 2026-07-27

## Runtime backends

All server modules use a single synchronous-read, asynchronous-write `SecretStore` facade. Runtime selection happens before the HTTP server binds, so agent tools can read an initialized in-memory credential view without synchronous disk access.

| Runtime                                       | Credential backend                                | At-rest behavior                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron-managed server                       | `ElectronSecretStore` over Electron `safeStorage` | The main process writes OS-protected ciphertext to `<userData>/data/secure-secrets.json`; decrypted values are sent once to the trusted server utility process and retained in server memory for synchronous tool access. |
| Standalone web/server with `HUABU_SECRET_KEY` | `EncryptedFileSecretStore` with AES-256-GCM       | UI-saved credentials are independently encrypted with random 96-bit IVs and authenticated metadata in `<dataDir>/encrypted-secrets.json`; the Base64 32-byte master key remains outside the data directory.               |
| Standalone web/server without a master key    | `EnvironmentSecretStore`                          | Environment values are available as read-only fallbacks. Settings writes are rejected, and no credential is persisted as plaintext.                                                                                       |
| Electron with an external development server  | External server's own backend                     | Electron does not migrate or expose its local secure store because it does not own the external process.                                                                                                                  |

Electron enables the bridge with `HUABU_SECRET_BRIDGE=1`; the server waits for a `secret:init` snapshot over `utilityProcess` messaging before binding its HTTP port, and settings mutations are acknowledged only after Electron has encrypted and atomically persisted the new value.

The main process validates every bridged mutation before touching `safeStorage`, rejecting anything malformed with `Invalid secure credential mutation`. That validation matches the secret id by **shape** (`llm` / `integration` / `oauth` namespace, one to three `:`-separated segments, bounded length) rather than against a copy of the server's `SECRET_IDS`. The distinction matters: the server process already receives every decrypted secret in the `secret:init` snapshot, so enumerating ids in Electron buys no confidentiality — it only keeps junk out of the vault. An exact list bought that marginal hygiene at the price of a recurring outage class, because a server-side id the desktop package forgot to mirror was rejected and the credential silently never persisted ([microsoft/Huabu#40](https://github.com/microsoft/Huabu/issues/40)). Shape validation keeps the hygiene and removes the hand-synced duplication, so adding a server secret that follows the naming scheme needs no desktop change. The server's `llmProviderApiKeySecretId` generator enforces the provider segment's character and 64-character length invariant before producing an id; Electron retains the same bounded shape as defense at the IPC boundary. The accepted and rejected shapes are pinned in [`apps/desktop/src/secure-secrets.test.ts`](../../apps/desktop/src/secure-secrets.test.ts), and the generator boundary is pinned in [`apps/server/src/security/secret-ids.test.ts`](../../apps/server/src/security/secret-ids.test.ts).

The `pi-ai` credential adapter preserves the `CredentialStore.modify` contract during concurrent OAuth refresh: a returned credential replaces the stored value, while `undefined` leaves the current value unchanged because another locked caller may already have refreshed it. Credential removal is performed only through `delete`; treating a no-op `modify` as deletion would erase a freshly rotated Copilot credential when several requests observe expiry together.

OAuth API errors expose the deepest message in an `Error.cause` chain so a persistence rejection remains actionable after `pi-ai` wraps it. The response includes only the selected message, never the error object or stack. In Settings, a device code remains visible and copyable while polling, and the provider verification page opens only after an explicit user action.

The source workflows `pnpm dev` and `pnpm dev:desktop` run the server as an external development process, so they use the standalone backend rather than Electron `safeStorage`. They require a stable `HUABU_SECRET_KEY` when the Settings UI persists credentials or when an encrypted credential file already exists.

For standalone deployments, the encrypted primary backend wins over the environment fallback. Writes target only the primary backend, and the application never writes to `.env`. The one deliberate `process.env` mutation is at startup: `initializeSecretStore()` reads `HUABU_SECRET_KEY` once, parses it into the in-memory `EncryptedFileSecretStore` master key, then deletes `process.env.HUABU_SECRET_KEY` so the raw key can never be inherited by a forked child process (the agentlet daemon and the external agents it spawns). This is defense in depth alongside the agentlet transport's `HUABU_` namespace strip — see [`agent-reachback.md`](./agent-reachback.md) ("Environment injection and isolation"). A `.env` file is merely one way `dotenv` can populate `process.env` during startup.

The renderer never receives plaintext credentials. Existing HTTP read models continue to return only authentication/status booleans.

Settings API updates for optional capability credentials use an explicit three-state patch contract: omitting a key preserves the persisted value, a non-empty string sets or replaces it, and `null` removes the value stored by Huabu. Removing a persisted key preserves non-secret provider configuration and does not alter deployment-owned environment variables; an environment fallback may therefore keep the capability available at runtime.

## Electron encrypted store

The encrypted file is versioned JSON whose values are Base64 representations of buffers returned by `safeStorage.encryptString()`; Base64 is transport encoding, while the security comes from the platform backend used by Electron.

Windows uses DPAPI, macOS uses Keychain, and Linux requires Secret Service or KWallet. Electron startup fails closed when encryption is unavailable or Linux reports the insecure `basic_text` backend.

Non-secret provider configuration remains in `llm-config.json` and integration status is derived from the secure in-memory snapshot. Environment-variable fallbacks remain supported and are not migrated because they are deployment-owned configuration rather than UI-owned persisted values.

Key resolution reads the secret store only; there is no caller-supplied or on-disk plaintext fallback.

## Standalone encrypted store

`HUABU_SECRET_KEY` must be canonical Base64 encoding of exactly 32 random bytes. It is used directly as the AES-256 key; each credential entry receives a new random 12-byte IV and uses its stable secret ID as additional authenticated data. The file records its version, algorithm, non-secret key fingerprint, IV, authentication tag, and ciphertext for each entry.

Every mutation constructs a new encrypted snapshot, atomically replaces the file, reads it back, authenticates and decrypts every entry, and only then publishes the new in-memory snapshot. A wrong key, malformed file, modified ciphertext, or authentication failure aborts startup or rejects the write.

The standalone server may run without `HUABU_SECRET_KEY` when it has no encrypted file. This environment-only mode supports headless and container deployments but deliberately rejects Settings writes. If an encrypted file exists without a key, startup fails with an actionable error instead of silently discarding credentials.

The deployment readiness endpoint exposes only whether the selected backend is writable and the stable `secret-key-required` reason for environment-only mode. Settings uses that capability to disable API-key and OAuth mutations before they fail; backend kind, key material, credential values, and environment fallbacks remain private. See [`deployment-security.md`](./deployment-security.md).

## Code entry points

| File                                                                                                                       | Responsibility                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`apps/desktop/src/secure-secrets.ts`](../../apps/desktop/src/secure-secrets.ts)                                           | Electron encrypted vault, secret-id shape validation, and write verification. |
| [`apps/desktop/src/main.ts`](../../apps/desktop/src/main.ts)                                                               | `safeStorage` availability policy and utility-process secret bridge host.     |
| [`apps/server/src/security/desktop-secret-bridge.ts`](../../apps/server/src/security/desktop-secret-bridge.ts)             | Server startup handshake, in-memory snapshot, and acknowledged mutation RPC.  |
| [`apps/server/src/security/secret-store.ts`](../../apps/server/src/security/secret-store.ts)                               | Runtime backend selection, environment fallback, and module-facing facade.    |
| [`apps/server/src/security/secret-ids.ts`](../../apps/server/src/security/secret-ids.ts)                                   | Canonical secret-id constants, provider-id derivation, and id validation.     |
| [`apps/server/src/security/encrypted-file-secret-store.ts`](../../apps/server/src/security/encrypted-file-secret-store.ts) | Standalone AES-256-GCM persistence and authenticated read-back verification.  |
| [`apps/server/src/security/environment-secret-store.ts`](../../apps/server/src/security/environment-secret-store.ts)       | Read-only deployment environment fallback.                                    |
| [`apps/server/src/modules/agent/llm.ts`](../../apps/server/src/modules/agent/llm.ts)                                       | Chat, utility, and image API-key resolution.                                  |
| [`apps/server/src/modules/agent/oauth.ts`](../../apps/server/src/modules/agent/oauth.ts)                                   | Copilot OAuth credential persistence.                                         |
| [`apps/server/src/modules/integrations/integrations.ts`](../../apps/server/src/modules/integrations/integrations.ts)       | Tavily and RapidAPI credential persistence.                                   |
