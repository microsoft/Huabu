# Credential Storage

> Current credential persistence for Electron and standalone server deployments. Last updated: 2026-07-10

## Runtime backends

Electron and standalone deployments deliberately use different persistence backends behind the existing settings APIs.

| Runtime                                      | Credential backend                                  | At-rest behavior                                                                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron-managed server                      | Electron `safeStorage` in the main process          | The main process writes OS-protected ciphertext to `<userData>/data/secure-secrets.json`; decrypted values are sent once to the trusted server utility process and retained in server memory for synchronous tool access. |
| Standalone web/server                        | Existing server JSON files or environment variables | UI-saved credentials remain plaintext in the server data directory; deployment secrets should preferably come from environment or an external secret manager until a server-side encrypted backend is implemented.        |
| Electron with an external development server | External server's own backend                       | Electron does not migrate or expose its local secure store because it does not own the external process.                                                                                                                  |

Electron enables the bridge with `HUABU_SECRET_BRIDGE=1`; the server waits for a `secret:init` snapshot over `utilityProcess` messaging before binding its HTTP port, and settings mutations are acknowledged only after Electron has encrypted and atomically persisted the new value.

The renderer never receives plaintext credentials. Existing HTTP read models continue to return only authentication/status booleans.

## Electron encrypted store

The encrypted file is versioned JSON whose values are Base64 representations of buffers returned by `safeStorage.encryptString()`; Base64 is transport encoding, while the security comes from the platform backend used by Electron.

Windows uses DPAPI, macOS uses Keychain, and Linux requires Secret Service or KWallet. Electron startup fails closed when encryption is unavailable or Linux reports the insecure `basic_text` backend.

Non-secret provider configuration remains in `llm-config.json` and integration status is derived from the secure in-memory snapshot. Environment-variable fallbacks remain supported and are not migrated because they are deployment-owned configuration rather than UI-owned persisted values.

## Automatic plaintext migration

Before Electron starts its managed server, the main process scans `llm-config.json`, `integrations.json`, and `oauth-credentials.json` in its data directory.

Migration encrypts all discovered LLM provider keys, image keys, Tavily/RapidAPI keys, and GitHub Copilot OAuth credentials into `secure-secrets.json`, writes the encrypted file atomically, reads it back, and verifies every migrated value can be decrypted before removing plaintext fields from the legacy files.

An existing encrypted value wins over stale plaintext left by an interrupted migration. If encryption, persistence, or verification fails, plaintext source fields are not removed; startup fails rather than silently losing credentials or falling back to insecure Electron storage.

## Code entry points

| File                                                                                                                 | Responsibility                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`apps/desktop/src/secure-secrets.ts`](../../apps/desktop/src/secure-secrets.ts)                                     | Electron encrypted file, migration, verification, and plaintext scrubbing.   |
| [`apps/desktop/src/main.ts`](../../apps/desktop/src/main.ts)                                                         | `safeStorage` availability policy and utility-process secret bridge host.    |
| [`apps/server/src/security/desktop-secret-bridge.ts`](../../apps/server/src/security/desktop-secret-bridge.ts)       | Server startup handshake, in-memory snapshot, and acknowledged mutation RPC. |
| [`apps/server/src/security/secret-ids.ts`](../../apps/server/src/security/secret-ids.ts)                             | Stable credential identifiers used by server modules.                        |
| [`apps/server/src/modules/agent/llm.ts`](../../apps/server/src/modules/agent/llm.ts)                                 | Chat, utility, and image API-key resolution.                                 |
| [`apps/server/src/modules/agent/oauth.ts`](../../apps/server/src/modules/agent/oauth.ts)                             | Copilot OAuth credential persistence.                                        |
| [`apps/server/src/modules/integrations/integrations.ts`](../../apps/server/src/modules/integrations/integrations.ts) | Tavily and RapidAPI credential persistence.                                  |
