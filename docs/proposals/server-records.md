# Server records in the structured backend

Status: Implemented (pending review)

Last updated: 2026-11-18

## Context

With `HUABU_STRUCTURED_BACKEND=postgres` and `HUABU_BLOB_BACKEND=azure`, Workspaces, Spaces, nodes, logs, Tasks, agent conversations, Bubble identity, and Space bytes no longer touch the Server's local filesystem. The Server still keeps a second category of durable state as JSON files directly under `HUABU_DATA_DIR`: state about the Server itself and the people using it, owned by no Workspace.

| File under `HUABU_DATA_DIR`                                                                                                                     | Owner                                  | Contents                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `encrypted-secrets.json`                                                                                                                        | `security/encrypted-*-secret-store.ts` | Every UI-saved credential, including members' personal keys and the managed Agentlet connection token          |
| `llm-config.json`, `agent-defaults.json`, `agent-change-review-config.json`, `external-agent-runtime-config.json`, `agentlet-device-names.json` | the matching settings modules          | Deployment settings; in Bubble mode, each member's copy lives under `people/<person key>/`                     |
| `agent-profiles/registry.json`, `user-agent-profiles/registry.json`                                                                             | Agenetes `agent-profile` registry      | Agent Profiles for local and Bubble mode                                                                       |
| `agentlet-owners.json`                                                                                                                          | `identity/agent-credentials.ts`        | Durable device ownership                                                                                       |
| `agent-credential-versions.json`                                                                                                                | `identity/agent-credentials.ts`        | Per-person device credential versions; a reset increments the version and invalidates older signed credentials |

The App Service container therefore requires persistent `/home` storage even when every content backend is remote. Losing the data directory loses saved credentials, settings, and Agent Profiles while Workspace records survive. Losing `agent-credential-versions.json` while the connection token survives (for example `HUABU_CONNECTION_TOKEN` from Key Vault) is worse than losing everything: versions fall back to `0`, so device credentials a person deliberately reset become valid again and their current ones stop working.

## Decision

Server records become a third storage port, served by the **structured** backend that already holds Workspace records. Blob storage is the wrong medium: these are small mutable JSON documents, and device ownership and credential versions are read-modify-write maps that need serialized, acknowledged updates rather than whole-object uploads. Dropping them online is not acceptable: they are credentials, settings, Profiles, and revocation state.

### Port

`modules/storage/ports/server-records.ts` defines `ServerRecordStore`:

- A record is a JSON document addressed by `{ owner, name }`. `name` comes from a closed registry (`SERVER_RECORDS`) that also says whether a member may hold a personal copy. `owner` is `null` for the deployment and otherwise the existing opaque 32-hex person key from `identity/personal-settings.ts`, so no principal id becomes a path or a column value.
- `get(key)` is asynchronous and returns a private copy of the latest acknowledged value, or `null` when the record was never written. It reads the medium on every call; no adapter keeps a copy between calls. Before this change every record was a file read on each use, so a value one Server process wrote was visible to the next read in any other; an in-process copy would have added a new way for processes sharing a database to disagree (a device credential reset that another process never sees, for example).
- `put(key, value)` is asynchronous and resolves only after the value is committed: visible to `get`, and kept when the process exits or its container is replaced. Power-loss durability is the backend's: PostgreSQL commits durably and Disk flushes the file and its directory, while SQLite runs WAL with `synchronous=NORMAL` for every table, so a machine crash may lose its latest commits. Before this change these files were written without any flush, so no backend is weaker than before.
- The two database adapters also offer `insertMissing(records)`, the import below: one transaction that writes each record the database lacks and leaves every record it holds. Disk has no import, and only the Disk adapter enumerates its records, for that import.
- Records are never deleted. Every owner replaces its whole document, so "absent" always means "never written", which keeps import idempotent.

### Adapters

One file per structured backend, each beside that backend's other adapters:

| Backend    | File                                  | Persistence                                                                                                                       | Reads                                  |
| ---------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `disk`     | `backends/disk/server-records.ts`     | The existing files at their existing paths (`backends/disk/data-dir.ts` owns the name → file mapping); atomic, fsynced, mode 0600 | The file, on every call                |
| `sqlite`   | `backends/sqlite/server-records.ts`   | `server_records` table in `huabu.sqlite` (schema v3)                                                                              | `SELECT` by primary key, on every call |
| `postgres` | `backends/postgres/server-records.ts` | `server_records` table in the Huabu database/schema (schema v3)                                                                   | `SELECT` by primary key, on every call |

Both SQL tables have the same shape: `(owner_key TEXT, name TEXT, record_json TEXT, updated_at)` with primary key `(owner_key, name)` and `''` for the deployment. The three adapters differ only in their medium.

A reusable contract suite (`ports/contracts/server-records.contract.ts`) runs against all three adapters.

### Composition

Server records get their own composition root, `modules/storage/server-records.ts`, beside `storage.ts`. It selects the record adapter and owns the `ServerRecords` facade, and it imports nothing else of the storage graph: the Vite dev server opens records while loading its configuration to read a saved password, and the rest of that graph (through `@huabu/shared`'s TypeScript source) does not load there. The process's SQL connections move to `modules/storage/connections.ts`, which both roots borrow from; `module-boundaries.test.ts` names these three files as the only ones that select a backend or open a shared connection.

- It selects the adapter for the configured structured backend on the same process-wide SQLite connection or PostgreSQL pool the Workspace and Space adapters borrow. A connection opens from the environment it is asked for, so `setup` and the Vite dev server open the database their own environment names; once open, a request naming another database is refused rather than served from the open one.
- `update(key, change)` serializes read-modify-write per record with a keyed mutex: the change sees the latest acknowledged value and its result is acknowledged before the next change runs. Owners that need atomic claims (device ownership, credential versions, device names, the credential envelope) use it. `put(key, value)` takes its turn on the same mutex without reading the old value, so saving a valid replacement repairs a damaged record. A value that serializes to `null` (`NaN`, or an object whose `toJSON()` returns `null`) is refused, because it would read back as damage.
- `initServerRecords(env)` opens the backend before the credential store initializes, because credentials are server records. The storage profile comes only from the environment, so this ordering introduces no cycle. `initStorage()` reuses the open records, or opens them for an explicitly chosen profile.
- For `sqlite` and `postgres`, opening imports the legacy data-directory files when the database holds no server record yet. Opening upgrades the schema, which the previous version cannot open, so the files are read and validated first, on a connection that does not migrate: an unreadable or damaged file, or a directory the Server cannot list, fails startup with the database as it was, instead of being silently dropped. The records are then inserted in one transaction that skips any record already present, so a second process importing at the same time never replaces a record written since. A database holding any record has had its import, and its files are never read again, so a damaged obsolete file cannot block a migrated database.
- Before opening, the credential store checks the master key against the legacy credential envelope that import would read. Startup and setup's saved-password lookup share this check, and on PostgreSQL it also refuses a missing key, so a wrong or missing key fails with nothing imported or upgraded. Once imported, the database's credentials are the ones in use and the file is not checked.
- Disk remains usable without explicit initialization, matching the lazy Disk path of `storage.ts`.

### Reads per operation

Because a read now reaches storage (a primary-key round trip on PostgreSQL), owners read a record once per operation and derive everything that operation needs from it, never once per item. The places that previously looked up the same record repeatedly within one operation now read it once:

- Device access is a `DeviceAccess` view over one read of `device-owners`. A Profile listing, a registry lookup or mutation, and the Settings device list each read ownership once and filter every Profile or device against it.
- A connected device's owner is the principal its handshake admitted, which the Gateway already keeps as the connection's `metadata.principalId`; the handshake records or matches the ownership record before admitting it, and ownership never changes. Placement among connected devices (`resolveConnectedAgentletId`), connection filters, revalidation sweeps, and credential-reset disconnects therefore read no record.
- Model-role resolution reads `model-settings` once per resolution. Building an ACP workload spec reads its Profile once and derives the snapshot, remembered preferences, and observed catalogue from it. A full-Canvas save resolves the default Agent binding at most once for all new conversations in it. Tool binding reads the image model family only when the `generate_image` tool is bound.
- Credential checks read `agent-credential-versions` once per check, as they read the file before. HTTP requests classify a bearer token by signature alone and read its version once.

The per-operation cost matches the file deployments it replaces on App Service, where the data directory was a network share read on every use.

### Owners

- `EncryptedFileSecretStore` becomes `EncryptedSecretStore`, persisting its unchanged AES-256-GCM envelope as the deployment's `credentials` record. Its read-back verification decrypts the acknowledged record before publishing new values, and each write runs from its update through that publication before the next starts, so an older verification cannot publish over a newer one.
- On `postgres`, the master key must come from `HUABU_SECRET_KEY`. An automatically generated key would live in the local private-config directory while the ciphertext lives in the database, recreating the dependency this change removes; startup fails with instructions before connecting. Disk and SQLite keep the automatic key because their ciphertext is local too.
- Settings modules replace `settingsFilePath(file)` with `settingsRecordKey(name)` and persist through the facade; their parsing, defaults, and error behavior are unchanged. Their getters and setters become async, and so do the model-settings readers in `agent/llm.ts` (`getLLMModel`, `getModelsForProvider`, the image-configuration readers) and the service-provisioner adapters that project them. A setter whose read and write used to be one synchronous step keeps it atomic another way: the chat, image, and utility setters, which edit one shared `model-settings` document around awaits on the model catalogue and the credential store, run one at a time per owner; automatic Utility Agent initialization decides that `agent-defaults` is absent inside the same `update` that writes it, so an explicit save that lands first wins; and a remembered session preference patches its Profile fenced on the revision it merged against, rereading and rechecking the execution revision on a conflict. Only utility-tier model roles read the settings for the utility model.
- `agent-credentials.ts` keeps ownership and credential versions as `device-owners` and `agent-credential-versions` records. Ownership claims and resets use `update`. A device handshake rechecks its credential and membership after its lookups and its ownership claim, so a reset or revocation that lands during them refuses the handshake. One that lands after the last check is caught by the disconnect itself: a reset or revocation waits for the handshakes in flight for that person to register, then sweeps again, because a read now leaves a gap between a handshake's last check and the Gateway registering its connection. `canUseAgentlet` is replaced by `readDeviceAccess()` (one read, for devices that may be offline) and `connectedDeviceAccess()` (connected devices, no read), which share one access rule; `readAgentCredential`, `agentletOwner`, `requireOwnAgentlet`, and `ownDeviceCredential` become async.
- The Agenetes `AgentProfileRegistryStore` gains an async `save` and an async, nullable `load`; a registry opens through `AgentProfileRegistry.open(store, options)`. Registry mutations become async and serialized, and the registry document codec is exported so Huabu's server-record store and Agenetes' file store share one format. Huabu supplies a store over the `agent-profiles` or `user-agent-profiles` record. Automatic harness discovery serializes each device's lookup-and-create, which used to rely on having no `await` between them, and rechecks after every await that a disconnect or reconnect has not made it obsolete. The Files proxy likewise rechecks its session after its Profile lookup, before spawning.
- The registry's synchronous `canAccess` predicate becomes `resolveAccess`, resolved once at the start of each read and mutation, so a host that reads ownership from storage reads it once per operation. Registry reads (`getProfile`, `listProfiles`, `listSelectableProfileIds`, `snapshotProfile`) become async; the registry still serves Profiles from the state it opened with.
- Three other Agenetes host hooks that read settings may now resolve asynchronously: the supervisor's `getMaxAgents` (read before forking the daemon), the ACP runtime policy's `getIdleTimeoutSecs` (read once per session spawn), and the profile cache port's `readCommands` (the warm-start command list, which an agent's own list that arrives meanwhile still overrides, even an empty one; a read that fails is a cache miss, so the session is still registered).

### What stays local, and why that is safe

| Path                                                    | Why it may be lost                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `logs/`                                                 | Diagnostics; App Service collects stdout                                                                       |
| `acp-profile-schema-cache.json`                         | Cache, rebuilt on demand                                                                                       |
| `canary-redeploy-*.json`, `logs/canary-redeploy.log`    | Source-checkout Canary only; unavailable in the container                                                      |
| `ink-ocr-config.json`, `acp-config.json`, `agent-team/` | Legacy inputs read or removed once; never written                                                              |
| `storage/disk/`, `storage/sqlite/`, `workspaces/`       | Only used by the Disk and SQLite backends                                                                      |
| `HUABU_CONFIG_DIR` (`master-key`, `deployment.json`)    | Not created when `HUABU_SECRET_KEY` (required on PostgreSQL) and deployment settings come from the environment |

With `postgres` + `azure` and `HUABU_SECRET_KEY` supplied, a Bubble deployment's container no longer needs `WEBSITES_ENABLE_APP_SERVICE_STORAGE`. In local identity mode the Server supervises a bundled Agentlet whose device identity lives in the `node` user's home, so that deployment keeps persistent storage ([web container](../architecture/web-container.md#app-service-configuration)).

## Migration

- Disk deployments, including Desktop, see no change: the Disk adapter reads and writes the same files.
- Existing SQLite and PostgreSQL deployments import their data-directory records on the first start of this version. Keep the existing mount for that first start. Only a deployment whose records and bytes are all remote (`postgres` with `azure` blobs) may then remove it; SQLite keeps its database, and Disk blobs their bytes, in the data directory, so those deployments keep the mount.
- An Ink OCR endpoint that only the legacy `ink-ocr-config.json` holds is saved into the credential record on the first start of this version, together with the effective key, so it survives the mount's removal.
- A PostgreSQL deployment that relied on an automatically generated key must set `HUABU_SECRET_KEY` to the contents of `<HUABU_CONFIG_DIR>/master-key` before upgrading. The key is checked against the legacy envelope before the database is opened, so a wrong key fails startup or setup without changing anything.

## Not in scope

- Multiple concurrent Server replicas. This change adds no in-process copy of a server record, but existing in-process views remain: live Space sync, Canvas write locks, agent turn leases, device connections, the Agent Profile registry's state, the decrypted credential map, and the active model configuration. Replicas would need cross-process coordination for those, and cross-process serialization of `update`, which is per process here as file writes were before.
- Moving logs off local disk.
- Desktop's Electron `safeStorage` vault, which belongs to the desktop process rather than the Server.
