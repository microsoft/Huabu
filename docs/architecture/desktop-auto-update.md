# Desktop Auto-Update Architecture

How the packaged Huabu desktop app detects, downloads, and installs new releases via [`electron-updater`](https://www.electron.build/auto-update).

## Policy

- **Notify, don't ambush.** The app checks for updates in the background but never downloads or forces a restart on its own. The user explicitly starts the download; once it finishes, they can restart immediately to install, or continue working and let the update install during their next normal app exit. The next launch then runs the new version.
- **Three check triggers:** on startup (delayed ~8s), on a 6-hour timer, and on explicit request from Settings or the application menu. On macOS this is the native system application menu; Windows and Linux use the in-app `AppMenu` dropdown.
- **Immediate manual feedback.** A user-triggered check shows a persistent “Checking…” toast, then replaces it with the up-to-date version, available version, or failure result. Startup and periodic background checks do not show these toasts.
- **Desktop only.** Everything no-ops in the browser SPA and in unpackaged `electron .` dev runs (no `app-update.yml` to resolve).

## Data flow

```
electron-updater (main)          preload bridge            renderer
  checkForUpdates() ─┐
   ├ checking ────────┼─ webContents.send ─→ update:status ─→ useAppUpdate()
   ├ update-available ┤                                          │
   ├ download-progress┤            update:check   ←── check()  ──┤
   ├ update-downloaded┤            update:download ←── download()┤ UpdateButton
   └ error ───────────┘            update:install  ←── install() ┘
                          update:get-state → last snapshot (sync on mount)
```

The explicit `update:install` action lets the user restart and install immediately. After a user-initiated download completes, `autoInstallOnAppQuit` also allows electron-updater to install during the next normal app exit; it never interrupts active work by forcing the app to quit.

The main process owns a single `UpdateStatus` snapshot, pushes every transition over the `update:status` channel, and answers `update:get-state` so a freshly-mounted renderer syncs immediately. The renderer never talks to `electron-updater` directly — only through the sandboxed `electronBridge.updater` surface.

**The persistent "Update failed" badge means a _download_ failed, not a _check_.** Failing to reach the release feed is not the same as an update failing, so the two are surfaced differently:

- **Download / install failure** (an explicit `update:download` or `update:install` the user started) → snapshot transitions to `error`, and the header shows the persistent red "Update failed" badge (click to retry).
- **Version-check failure** — whether a silent startup / periodic poll or a manual "check for updates" — installs nothing, so it never raises that badge. Background polls are logged to the console and clear their transient `checking` state back to `idle`. A manual check additionally returns the reason to the renderer, which shows a one-off toast ("Unable to check for updates: …") — no persistent badge.

electron-updater raises a single shared `error` event for checks, downloads, and installs alike, so [updater.ts](../../apps/desktop/src/updater.ts) attributes each error to its operation **by Error identity**, never by a blanket "an install is in flight" flag (which would wrongly swallow every coincident check error as an install failure). A check (`checkForUpdates()`) and a download (`downloadUpdate()`) each reject their own promise with the _same_ `Error` instance the shared event carries, so the handler awaiting that promise records the instance in an `operationErrors` `WeakSet` — claiming it. An install (`quitAndInstall()`) exposes no promise, so its failure is the one error that reaches the shared event **unclaimed**.

The shared `error` listener therefore defers one macrotask (so the operation's promise `catch` — a microtask — runs first and claims the error), then:

- **claimed** → the originating check/download already handled it; do nothing.
- **unclaimed, an install committed** (`installOpActive`) → the installer itself failed; raise the persistent "Update failed" badge, even when the error arrives asynchronously and even when a background check failed first (that check error was claimed, so it never reaches here).
- **unclaimed, no install committed** → a stray error that installs nothing; log only, never a badge.

`installOpActive` latches on the first install request and gates only that middle case; it is never cleared by a coincident check/download error, because attribution — not the flag — is what keeps those from being mistaken for the install's own (possibly late) failure.

## The update feed

electron-updater reads the GitHub owner/repo from `app-update.yml`, which electron-builder bakes into the app at build time from the `publish` block in [electron-builder.yml](../../apps/desktop/electron-builder.yml). Builds and releases both live in this repository, so that block names it directly and no build-time configuration is involved.

## Release artifacts electron-updater requires

The `dist:*` scripts pass `--publish never`: electron-builder generates the update metadata but never publishes; `gh release upload` in the workflow does. For auto-update to work, the **release the app polls must carry the full set** (missing `latest*.yml` or the mac `.zip` silently breaks updates):

| Platform | Required release assets                          |
| -------- | ------------------------------------------------ |
| macOS    | `*.dmg`, `*.zip`, `*.blockmap`, `latest-mac.yml` |
| Windows  | `*.exe`, `*.exe.blockmap`, `latest.yml`          |

The `.dmg` / `.exe` are the human-facing first installs; the `.zip` (Squirrel.Mac) and `latest*.yml` feeds are what the running app consumes. When a build is relocated from the build-source repo to the public distribution repo, these metadata files must move with it.

## macOS signing dependency

Desktop packaging pins `electron-builder` to `26.16.1` in `apps/desktop/package.json` and resolves it through the shared `pnpm-lock.yaml`. This is the first stable v26 release containing the upstream [keychain password fix](https://github.com/electron-userland/electron-builder/pull/10172): `security import -P` needs the certificate password, but `security set-key-partition-list -k` needs the temporary keychain's own unlock password. Version `26.15.3` incorrectly reused the certificate password for the latter command, causing `SecKeychainUnlock` failures before signing or notarization.

Local builds, GitHub Actions, and Azure Pipelines use the same packaging dependency. Both CI paths install with `--frozen-lockfile`; no workflow-specific password substitution or signing bypass is required. Developer ID signing and Apple notarization remain enabled.

## Azure Pipelines packaging

The root [azure-pipelines.yml](../../azure-pipelines.yml) adds independent Microsoft-hosted Windows and macOS packaging jobs alongside the existing GitHub Actions release workflow. In Azure DevOps, select **New Pipeline > GitHub > microsoft/Huabu > Existing Azure Pipelines YAML file** and choose `/azure-pipelines.yml`; authorize repository access through the Azure DevOps GitHub integration. This pipeline publishes build artifacts only, not GitHub Releases, and does not change the application's GitHub update feed.

The current governed creation flow only reads YAML from the repository's default branch, so merge the configuration before creating the pipeline and performing its first cloud validation. Any organization-required governed templates must be verified during onboarding; this file defines standard Azure Pipelines jobs. Test with a manual run rather than pushing a release tag, which would also trigger the existing GitHub Actions release workflow.

Tag pushes matching `v*.*.*` trigger builds; branch pushes and pull requests do not. For manual runs on a branch, provide the `releaseTag` parameter (for example, `v0.1.0-rc.1`); when running a tag, its full `refs/tags/` reference takes precedence. Each job applies the release workflow's version validation and temporary rewrite of `apps/desktop/package.json`, without committing it or creating a tag. Both jobs read Node.js from `.nvmrc`, enable Corepack to use the integrity-pinned `packageManager`, then run `pnpm install --frozen-lockfile`, `pnpm run build:agentlet`, and the existing `pnpm run build:desktop:win` or `pnpm run build:desktop:mac` command. The existing NSIS x64 and macOS DMG/ZIP arm64/x64 targets remain unchanged.

Configure pipeline secret variables `CSC_LINK` (the base64-encoded Developer ID signing `.p12`), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` in Azure DevOps. They are mapped only into the macOS packaging step, which rejects missing or unresolved variables before building. Existing electron-builder certificate import, hardened runtime, and Apple notarization remain in use; no certificate or credential is stored in YAML, and no GitHub publishing token is required. Restrict access to these secrets and run signed builds only from trusted refs.

Both jobs validate the release workflow's required assets listed above, then publish the entire `$(Build.SourcesDirectory)/../huabu-electron-out` directory as Azure Pipeline artifacts named `huabu-windows` and `huabu-macos`. Download them from the pipeline run's **Artifacts** section. Uploading the entire directory preserves installer filenames, update metadata, blockmaps, and any additional output without filtering.

Windows uses `EsrpCodeSigning@6` with WIF/MSI authentication. Configure `CodeSignAuthSignCertificateName` (request-signing certificate), `CodeSignAppRegistrationTenantId` (tenant ID), `CodeSignAppRegistrationClientId` (WIF managed identity client ID), `CodeSignEsrpClientId` (ESRP-registered application client ID), `CodeSignConnectedServiceName` (onboarded service connection), and `CodeSignKeyVaultName` in Azure DevOps. No values for those settings are stored in the repository. The task uses the 1ES documentation's `CP-230012` Authenticode policy, SHA-256 digest, RFC 3161 timestamp, and verification operation; the ESRP account must be authorized for this policy. The service connection must be authorized for this pipeline. Do not grant signing access to untrusted refs.

Only the Azure Windows job opts into [electron-builder.esrp.yml](../../apps/desktop/electron-builder.esrp.yml), passing it through the existing `build:desktop:win` command. That configuration extends the normal packaging configuration and replaces local signing with an asynchronous signing hook. Packaging remains alive across sequential Azure tasks and pauses at each electron-builder signing boundary: `win-unpacked/Huabu.exe`, `win-unpacked/resources/elevate.exe` (the NSIS elevation helper), the temporary `Huabu-Setup-<version>.__uninstaller.exe`, and finally `Huabu-Setup-<version>.exe`. Each task signs exactly one staged `artifact.exe` under `$(HUABU_ESRP_STATE)/<stage>` in the agent's temporary directory, then verifies its timestamped Authenticode signature before releasing the hook. The hook copies those signed bytes back to the original path before packaging continues. Before these stages, electron-builder also requests signing for the nested `win-unpacked/resources/server/media/win32-x64/ffmpeg.exe` extra resource. This exact third-party path is explicitly preserved without re-signing, retaining the bytes and notices produced by the existing [media preparation and license checks](./node-preprocessing.md); it is not claimed to carry an ESRP signature. Third-party DLLs are not recursively re-signed; any other unexpected signing request still fails and requires review of this explicit file inventory.

The same build embeds the signed application, elevation helper, and uninstaller, then generates the installer blockmap and update hashes only after the final installer is signed. No post-build hash repair or second NSIS build is needed. Without a local certificate, the pinned electron-builder version initially generates `app-update.yml` without a publisher; `afterSign` writes the verified application signer's subject before archiving. Signature verification remains enabled, and no certificate name is hard-coded. The publish gate checks signed-byte receipts, a consistent publisher, the final installer SHA-512 and size in `latest.yml`, and blockmap coverage and checksums against a temporary blockmap regenerated using the installed electron-builder implementation. Missing signatures, timestamps, mismatched publishers, unexpected exits, and timeouts fail the job; an always-run cleanup step stops the owned packaging process tree. Local builds, GitHub Actions, macOS, installer targets, names, and installation options are unchanged.

The Windows pipeline runs `node --test apps/desktop/scripts/esrp-sign.test.mjs` after dependency installation. These tests cover signing handoffs and failure cases, completion polling races, exact-path FFmpeg preservation, pre-sign publisher lookup through the installed electron-builder implementation, publisher propagation, the task's variable mapping, and update metadata integrity without contacting ESRP. Completion polling accepts an exit-code file published between checks, still rejects a process that disappears without recording its result, and preserves nonzero build failures. An authenticated Azure run is still required to validate service connection authorization, `CP-230012` entitlement, and real timestamped signatures.

When distributing the ESRP-signed application, publish the signed installer and its matching update assets to the existing GitHub feed. The signed application's publisher check rejects unsigned installers from other build paths; do not mix unsigned installers into that update channel.

## Code entry points

| File/dir                                                                                                                             | Responsibility                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| [apps/desktop/src/updater.ts](../../apps/desktop/src/updater.ts)                                                                     | Main-process lifecycle, IPC handlers, status broadcast, periodic checks.                                           |
| [apps/desktop/src/main.ts](../../apps/desktop/src/main.ts)                                                                           | Registers updater IPC before first render; starts checks after window.                                             |
| [apps/desktop/src/preload.ts](../../apps/desktop/src/preload.ts)                                                                     | `electronBridge.updater` sandboxed bridge.                                                                         |
| [apps/desktop/electron-builder.yml](../../apps/desktop/electron-builder.yml)                                                         | `publish` feed (env-driven) + mac `zip` target for Squirrel.Mac.                                                   |
| [apps/web/src/hooks/useElectron.ts](../../apps/web/src/hooks/useElectron.ts)                                                         | `UpdateStatus` type + `ElectronUpdaterApi` bridge types.                                                           |
| [apps/web/src/hooks/useAppUpdate.ts](../../apps/web/src/hooks/useAppUpdate.ts)                                                       | Renderer hook: subscribe to status, expose check/download/install.                                                 |
| [apps/web/src/components/Shell/UpdateButton.tsx](../../apps/web/src/components/Shell/UpdateButton.tsx)                               | Header affordance rendering the update lifecycle.                                                                  |
| [apps/web/src/components/Shell/WindowChrome.tsx](../../apps/web/src/components/Shell/WindowChrome.tsx)                               | Mounts `UpdateButton` next to Handbook / Settings.                                                                 |
| [apps/web/src/components/Panels/Header/AppMenu.tsx](../../apps/web/src/components/Panels/Header/AppMenu.tsx)                         | Windows/Linux in-app “Check for Updates” command.                                                                  |
| [apps/web/src/components/Settings/sections/GeneralSettings.tsx](../../apps/web/src/components/Settings/sections/GeneralSettings.tsx) | Settings check command and current-version status.                                                                 |
| [apps/web/src/components/Shell/NativeMenuBridge.tsx](../../apps/web/src/components/Shell/NativeMenuBridge.tsx)                       | Maps the macOS native check command to `useAppUpdate`.                                                             |
| [apps/desktop/src/mac-menu.ts](../../apps/desktop/src/mac-menu.ts)                                                                   | Builds the macOS native application-menu command.                                                                  |
| [.github/workflows/release.yml](../../.github/workflows/release.yml)                                                                 | Builds mac + win, uploads installers + update metadata to the release.                                             |
| [azure-pipelines.yml](../../azure-pipelines.yml)                                                                                     | Independent Windows/macOS packaging jobs; publishes complete Pipeline artifacts without creating a GitHub Release. |
| [apps/desktop/scripts/esrp-build.ps1](../../apps/desktop/scripts/esrp-build.ps1)                                                     | Azure Windows packaging lifecycle, signing handoffs, Authenticode verification, and process cleanup.               |
| [apps/desktop/scripts/esrp-sign.mjs](../../apps/desktop/scripts/esrp-sign.mjs)                                                       | CI-only electron-builder signing hook and verified update publisher configuration.                                 |
| [apps/desktop/scripts/esrp-validate.mjs](../../apps/desktop/scripts/esrp-validate.mjs)                                               | Signed release byte, update metadata, and blockmap coverage checks before publication.                             |
| [.github/workflows/nightly.yml](../../.github/workflows/nightly.yml)                                                                 | Builds nightly mac + win assets with the same feed and completeness contract.                                      |
