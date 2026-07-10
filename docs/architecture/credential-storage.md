# Credential Storage

> Credential persistence for Electron and standalone server deployments. Last updated: 2026-07-10

## Runtime backends

All server modules use a single synchronous-read, asynchronous-write `SecretStore` facade. Runtime selection happens before the HTTP server binds, so agent tools can read an initialized in-memory credential view without synchronous disk access.

| Runtime                                       | Credential backend                                | At-rest behavior                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron-managed server                       | `ElectronSecretStore` over Electron `safeStorage` | The main process writes OS-protected ciphertext to `<userData>/data/secure-secrets.json`; decrypted values are sent once to the trusted server utility process and retained in server memory for synchronous tool access. |
| Standalone web/server with `HUABU_SECRET_KEY` | `EncryptedFileSecretStore` with AES-256-GCM       | UI-saved credentials are independently encrypted with random 96-bit IVs and authenticated metadata in `<dataDir>/encrypted-secrets.json`; the Base64 32-byte master key remains outside the data directory.               |
| Standalone web/server without a master key    | `EnvironmentSecretStore`                          | Environment values are available as read-only fallbacks. Settings writes are rejected, and no credential is persisted as plaintext.                                                                                       |
| Electron with an external development server  | External server's own backend                     | Electron does not migrate or expose its local secure store because it does not own the external process.                                                                                                                  |

Electron enables the bridge with `HUABU_SECRET_BRIDGE=1`; the server waits for a `secret:init` snapshot over `utilityProcess` messaging before binding its HTTP port, and settings mutations are acknowledged only after Electron has encrypted and atomically persisted the new value.

For standalone deployments, the encrypted primary backend wins over the environment fallback. Writes target only the primary backend; the application never modifies `.env` or `process.env`. A `.env` file is merely one way `dotenv` can populate `process.env` during startup.

The renderer never receives plaintext credentials. Existing HTTP read models continue to return only authentication/status booleans.

## Electron encrypted store

The encrypted file is versioned JSON whose values are Base64 representations of buffers returned by `safeStorage.encryptString()`; Base64 is transport encoding, while the security comes from the platform backend used by Electron.

Windows uses DPAPI, macOS uses Keychain, and Linux requires Secret Service or KWallet. Electron startup fails closed when encryption is unavailable or Linux reports the insecure `basic_text` backend.

Non-secret provider configuration remains in `llm-config.json` and integration status is derived from the secure in-memory snapshot. Environment-variable fallbacks remain supported and are not migrated because they are deployment-owned configuration rather than UI-owned persisted values.

## Standalone encrypted store

`HUABU_SECRET_KEY` must be canonical Base64 encoding of exactly 32 random bytes. It is used directly as the AES-256 key; each credential entry receives a new random 12-byte IV and uses its stable secret ID as additional authenticated data. The file records its version, algorithm, non-secret key fingerprint, IV, authentication tag, and ciphertext for each entry.

Every mutation constructs a new encrypted snapshot, atomically replaces the file, reads it back, authenticates and decrypts every entry, and only then publishes the new in-memory snapshot. A wrong key, malformed file, modified ciphertext, or authentication failure aborts startup or rejects the write.

The standalone server may run without `HUABU_SECRET_KEY` when it has no encrypted file and no legacy plaintext credentials. This environment-only mode supports headless and container deployments but deliberately rejects Settings writes. If an encrypted file or legacy plaintext credential exists without a key, startup fails with an actionable error instead of silently discarding or persisting credentials insecurely.

## Automatic plaintext migration

Before Electron starts its managed server, the main process scans `llm-config.json`, `integrations.json`, and `oauth-credentials.json` in its data directory.

Migration encrypts all discovered LLM provider keys, image keys, Tavily/RapidAPI keys, and GitHub Copilot OAuth credentials into `secure-secrets.json`, writes the encrypted file atomically, reads it back, and verifies every migrated value can be decrypted before removing plaintext fields from the legacy files.

An existing encrypted value wins over stale plaintext left by an interrupted migration. If encryption, persistence, or verification fails, plaintext source fields are not removed; startup fails rather than silently losing credentials or falling back to insecure Electron storage.

Standalone startup applies the same ordering when `HUABU_SECRET_KEY` is configured: it collects legacy fields, writes missing values to `encrypted-secrets.json`, verifies the authenticated file, and then removes only the plaintext fields. Repeated migration is idempotent, and existing encrypted values win over stale plaintext from an interrupted earlier attempt.

## Code entry points

| File                                                                                                                       | Responsibility                                                               |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`apps/desktop/src/secure-secrets.ts`](../../apps/desktop/src/secure-secrets.ts)                                           | Electron encrypted file, migration, verification, and plaintext scrubbing.   |
| [`apps/desktop/src/main.ts`](../../apps/desktop/src/main.ts)                                                               | `safeStorage` availability policy and utility-process secret bridge host.    |
| [`apps/server/src/security/desktop-secret-bridge.ts`](../../apps/server/src/security/desktop-secret-bridge.ts)             | Server startup handshake, in-memory snapshot, and acknowledged mutation RPC. |
| [`apps/server/src/security/secret-store.ts`](../../apps/server/src/security/secret-store.ts)                               | Runtime backend selection, environment fallback, and module-facing facade.   |
| [`apps/server/src/security/encrypted-file-secret-store.ts`](../../apps/server/src/security/encrypted-file-secret-store.ts) | Standalone AES-256-GCM persistence and authenticated read-back verification. |
| [`apps/server/src/security/environment-secret-store.ts`](../../apps/server/src/security/environment-secret-store.ts)       | Read-only deployment environment fallback.                                   |
| [`apps/server/src/security/plaintext-secret-migration.ts`](../../apps/server/src/security/plaintext-secret-migration.ts)   | Standalone legacy plaintext discovery, encryption, verification, and scrub.  |
| [`apps/server/src/security/secret-ids.ts`](../../apps/server/src/security/secret-ids.ts)                                   | Stable credential identifiers used by server modules.                        |
| [`apps/server/src/modules/agent/llm.ts`](../../apps/server/src/modules/agent/llm.ts)                                       | Chat, utility, and image API-key resolution.                                 |
| [`apps/server/src/modules/agent/oauth.ts`](../../apps/server/src/modules/agent/oauth.ts)                                   | Copilot OAuth credential persistence.                                        |
| [`apps/server/src/modules/integrations/integrations.ts`](../../apps/server/src/modules/integrations/integrations.ts)       | Tavily and RapidAPI credential persistence.                                  |
