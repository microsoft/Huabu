# Agent Profiles and Harness Discovery

Ordinary external agents use persisted Profiles and the existing ACP runtime. Agentlet owns the supported harness catalogue, detection, capability descriptions, and structured launch compilation; Agenetes owns the generic Profile registry; Huabu owns automatic Profile creation, the application default, and the Settings/API projection.

## Discovery and provisioning

```text
agentlet control connection / reconnection
  -> capability-gated server/discoverHarnesses through Gateway
  -> local PATH detection and default workspace preparation
  -> Huabu duplicate-safe creation in AgentProfileRegistry
  -> GET /api/acp/profiles
  -> Settings and Agent Node selectors
```

The catalogue resides in `external/agentlet/packages/local/src/harnesses/catalogue.ts`. Harness IDs are fixed catalogue IDs, such as `copilot`, `claude`, and `codex`, not generated instance IDs. Claude and Codex detection targets their ACP adapters rather than the similarly named native CLIs. Detection uses shell-free, bounded executable probes on the agentlet machine. An optional version probe failing does not make a located binary disappear; diagnostics distinguish unknown versions and actual lookup/workspace failures.

The daemon advertises versioned harness discovery support. The Gateway routes requests to an explicit `agentletId` and validates the reply. Unsupported or unavailable daemons fail explicitly; Huabu never substitutes Server-local PATH observations.

Automatic discovery requests workspace preparation. The daemon resolves its own home and creates or reuses `~/.agentlet/workspace/<harnessId>`, using only identities in its local catalogue. It reports an absolute `workingDirPath`. A workspace failure prevents automatic creation for that entry. Directories are shared by uses of that harness's default Profile, not isolated per Agent Node. Deleting a Profile never deletes its directory. Discovery does not start ACP sessions, install harnesses or skills, copy prompts, or provision credentials.

Huabu subscribes to machine connection events, includes machines already connected at registration, and invalidates stale results on reconnect, disconnect, and shutdown. After each successful response it synchronously checks and creates automatic defaults through the registry. The check and commit contain no asynchronous gap.

## Profile identity and customization

A Profile has `id`, `alias`, `agentletId`, `workingDirPath`, a launch configuration, optional `metadata.cliId`, and opaque `customData`. Launch is either the legacy `{ kind: 'acp-command', command }` or a structured `{ kind: 'acp-harness', harnessId, options?: { autoApprove? } }`. Profile IDs are the stable identities used by APIs, selectors and workload bindings. Runtime placement, launch configuration and directory retain the existing immutability contract; alias, metadata and display preferences remain editable.

Structured launches require the target daemon's versioned harness-launch capability. New automatic Profiles use this form when discovery advertises `launchVersion: 1`; older daemons keep the existing command provisioning path. The manual editor submits structured options rather than assembling shell commands in the browser. Legacy and Custom commands remain explicit trusted commands and are never inferred or converted from their text or editable `metadata.cliId`. Existing Profiles are not rewritten on discovery.

Discovery advertises structured launch only for a detected executable compatible with shell-free spawning. Windows shell-only wrappers, including npm `.cmd` shims, retain legacy command provisioning rather than creating an unusable structured Profile. Typed launch never silently enables shell execution.

Agentlet's harness wrapper describes `autoApprove`, `modelOverride`, and `sessionPersistence` using `supported`, `unsupported`, or `unknown`, and compiles supported launch options into executable, argv, and environment without a shell. ACP model configuration remains a protocol operation, not a guessed command-line flag. A detected binary does not prove authentication, model availability, or an ACP adapter's support for native CLI no-history options. Capability uncertainty must remain visible rather than being treated as success. This foundation does not add native print-mode execution or a new background permission policy.

After a successful structured ACP bootstrap, the driver persists the resolved `harnessLaunchPlan` in driver state and reuses it during recovery. The Profile recipe remains immutable and independent of later edits or deletion. The plan freezes launch arguments and launch-specific environment, not installed binary versions, inherited runtime environment, or a pre-bootstrap failure.

Huabu stores the reserved automatic-source marker in `customData.discoveredAgent`:

```json
{
  "version": 1,
  "agentletId": "machine-a",
  "harnessId": "copilot"
}
```

The tuple deduplicates only automatic defaults. Users may create multiple manual Profiles targeting the same machine/harness. Existing automatic Profiles are skipped rather than rewritten, preserving their IDs and customization. The create API rejects caller-supplied automatic provenance; patches preserve the original marker even when replacing or clearing other custom data, and reject attempts to change it. The generic Agenetes registry does not interpret this Huabu-owned field.

Deleting an automatic Profile is ordinary deletion. A later discovery may create a new default with a new Profile ID. There is no tombstone, reset endpoint, persisted availability state machine or reconciliation controller. Missing harnesses and failed probes do not delete existing Profiles. Existing ordinary workload snapshots remain independent of subsequent Profile edits or deletion.

## Persistence and retired Team data

The generic registry writes `<HUABU_DATA_DIR>/agent-profiles/registry.json` atomically. On first initialization only, it imports ordinary command Profiles from the former `agent-team/registry.json` and, when applicable, the older `agent-profiles.json` source. IDs, directories, metadata and custom data are preserved. Initialization is persisted even for an empty list; an existing new registry is authoritative, so a deleted Profile cannot reappear through repeated migration. Invalid command data and conflicting identities fail explicitly.

Old Team registry/config/setup-log files and conversation records are not deleted or rewritten by migration. Manifest Profiles are not imported as active Profiles or converted to executable commands. Agentlet and Agenetes reject retired Team launch recipes instead of silently treating them as ordinary commands.

The repository's `agent-teams/` manifest, prompt and Skill folders remain data assets. There is no bundled Team registration, manifest execution, setup worker, Team CLI, Team API, member Config UI or preparation lifecycle. Space Templates are a separate feature; their implementation is not required for ordinary Profiles. Historical design material is retained in [the archive](../archive/agent-teams-as-extensions.md).

## Settings and APIs

Owner-only `GET /api/agent/defaults` and `PUT /api/agent/defaults` expose `{ profileId: string | null, functionalModel: string }`, persisted atomically in `<HUABU_DATA_DIR>/agent-defaults.json`. Initial provisioning chooses a stable ordered external Profile and saves its identity. Reads do not discover agents, initialize defaults, or create sessions. Deleting or disconnecting the selected Profile does not choose a replacement or fall back to built-in Huabu; the selection remains explicit and unavailable until repaired by the user.

Settings > Huabu Agent exposes the default external Profile and one optional functional-task model text field above the transitional built-in provider controls; External Agents remains the Profile-management surface. The model value is trimmed; empty means inherit. Unsupported or unknown model capability is a warning, not a fabricated guarantee. The preference is staged for subsequent functional-workflow migration and does not change the existing pi-ai workloads, Profile launch configuration, or interactive chat's persisted session preferences. Per-workflow overrides, background permission decisions, historical conversation migration, and internal-agent removal are outside this foundation.

New conversations and newly created Agent Nodes snapshot the configured default unless the caller supplies an explicit binding. Existing conversations, restored nodes, and explicit selections keep their original binding. A missing or deleted default produces an actionable error on new creation, not a silent switch to another Profile. Loading a Space and initializing a legacy thread association remain independent of default availability.

`GET /api/acp/profiles` reads the canonical persisted list, selectable IDs, and saved `agentDefaults` without detecting harnesses, creating Profiles or starting sessions. Settings refreshes the shared Profile store on mount and after mutations; existing selectors refresh that same list when opened. There is no Web discovery store, selector-time materialization, or discovery polling.

`GET /api/acp/agent-cli` adapts the supervised agentlet's read-only discovery response, including launch support and capability observations, for the manual Profile editor. It does not prepare workspaces or create Profiles. Offline, unsupported and failed detection produces an explicit API error, not a misleading empty successful catalogue. Manual creation retains its required `workingDirPath` and existing custom-command flow; only automatic defaults get a daemon-prepared directory. Structured creation validates the target's reported support before persisting the Profile.

Settings presents ordinary Profiles, their existing edit/delete actions, and the agentlet health banner. Template/member Config/setup controls are removed. Catalogue and Profile endpoints remain owner-only. Shared HTTP contracts remain under `packages/shared/src/types/api/`, with type-only imports in the Web app.

## Code entry points

| File or directory                                                                                                       | Responsibility                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`local/src/harnesses/`](../../external/agentlet/packages/local/src/harnesses/)                                         | Canonical catalogue, local detector and default workspaces         |
| [`protocol/src/messages.ts`](../../external/agentlet/packages/protocol/src/messages.ts)                                 | Harness discovery wire contract                                    |
| [`agentlet-gateway/src/gateway.ts`](../../external/agenetes/packages/agentlet-gateway/src/gateway.ts)                   | Machine events and validated discovery routing                     |
| [`packages/agent-profile/`](../../external/agenetes/packages/agent-profile/)                                            | Generic Profile registry, persistence and snapshots                |
| [`agentlet-host/src/agent-profile-mount.ts`](../../external/agenetes/packages/agentlet-host/src/agent-profile-mount.ts) | Host registry composition                                          |
| [`harness-profile-discovery.ts`](../../apps/server/src/modules/agent/acp/harness-profile-discovery.ts)                  | Automatic creation, stale-result fencing and provenance protection |
| [`profiles.route.ts`](../../apps/server/src/modules/agent/acp/profiles.route.ts)                                        | Ordinary Profile HTTP API                                          |
| [`agent-cli.route.ts`](../../apps/server/src/modules/agent/acp/agent-cli.route.ts)                                      | Agentlet-backed manual-editor catalogue                            |
| [`Settings/agent-profiles/`](../../apps/web/src/components/Settings/agent-profiles/)                                    | Ordinary Profile Settings and editor                               |
| [`acpProfilesStore.ts`](../../apps/web/src/store/acpProfilesStore.ts)                                                   | Shared Profile snapshot for Settings and selectors                 |
