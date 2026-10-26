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

## TypeScript build toolchain

All workspaces that declare TypeScript, including the Agentlet and Agenetes subtrees and the documentation site, use the same `^6.0.3` dependency range and resolve to TypeScript `6.0.3` through the root `pnpm-lock.yaml`. Release builds use the workspace compiler selected by pnpm; no global compiler override is required.

The Agenetes instance, Agent Profile registry, and documentation site's mixed browser/SSR project explicitly load Node.js types with `types: ["node"]`, because TypeScript 6 no longer automatically includes visible `@types` packages. The documentation site resolves its `@/*` alias through `./src/*` without the deprecated `baseUrl` option.

## macOS signing dependency

Desktop packaging pins `electron-builder` to `26.16.1` in `apps/desktop/package.json` and resolves it through the shared `pnpm-lock.yaml`. This is the first stable v26 release containing the upstream [keychain password fix](https://github.com/electron-userland/electron-builder/pull/10172): `security import -P` needs the certificate password, but `security set-key-partition-list -k` needs the temporary keychain's own unlock password. Version `26.15.3` incorrectly reused the certificate password for the latter command, causing `SecKeychainUnlock` failures before signing or notarization.

Local builds, GitHub Actions, and Azure Pipelines use the same packaging dependency. Both CI paths install with `--frozen-lockfile`. GitHub Actions retains the electron-builder certificate import and notarization flow. Azure prepares ad-hoc-signed application bundles with electron-builder, then requires ESRP Developer ID signing and notarization before distribution packaging; ad-hoc bundles are never published.

The workspace overrides the `node-gyp > undici` packaging dependency to the published `6.29.0` release, within node-gyp's declared `^6.25.0` range. The previous `6.29.1` lockfile resolution is unavailable from the configured package feed and prevents a frozen dependency restore. This scoped override does not change the application's runtime Undici dependency.

## Azure Pipelines packaging

The root [azure-pipelines.yml](../../azure-pipelines.yml) adds independent Microsoft-hosted Windows and macOS packaging jobs alongside the existing GitHub Actions release workflow. In Azure DevOps, select **New Pipeline > GitHub > microsoft/Huabu > Existing Azure Pipelines YAML file** and choose `/azure-pipelines.yml`; authorize repository access through the Azure DevOps GitHub integration. This pipeline publishes build artifacts only, not GitHub Releases, and does not change the application's GitHub update feed.

The current governed creation flow only reads YAML from the repository's default branch, so the baseline YAML must be available there before creating a pipeline. An existing pipeline can validate a trusted PR branch with a manual branch run before merge, subject to Azure DevOps permissions and service-connection authorization. Any organization-required governed templates must be verified during onboarding; this file defines standard Azure Pipelines jobs. Test with a manual run rather than pushing a release tag, which would also trigger the existing GitHub Actions release workflow. Set `buildMacOS` to `false` for a Windows-only signing test; its default is `true`, preserving the normal two-platform build.

Tag pushes matching `v*.*.*` trigger builds; branch pushes and pull requests do not. For manual runs on a branch, provide the `releaseTag` parameter (for example, `v0.1.0-rc.1`); when running a tag, its full `refs/tags/` reference takes precedence. Each job applies the release workflow's version validation and temporary rewrite of `apps/desktop/package.json`, without committing it or creating a tag. Both jobs read Node.js from `.nvmrc`, enable Corepack to use the integrity-pinned `packageManager`, then run `pnpm install --frozen-lockfile` and `pnpm run build:agentlet`. Windows runs `pnpm run build:desktop:win` unchanged. macOS reuses `pnpm run build:desktop:mac` with the Azure-only `electron-builder.esrp.yml` overlay and a temporary output directory to prepare arm64/x64 application bundles before signing. The final distribution targets remain NSIS x64 and macOS DMG/ZIP arm64/x64.

For Azure macOS signing, install the separately shared ESRP Apple Code Signing extension in the Azure DevOps organization and authorize the pipeline's macOS agent and service connection. Configure `CodeSignConnectedServiceName`, `CodeSignAppRegistrationClientId`, `CodeSignAppRegistrationTenantId`, `CodeSignKeyVaultName`, and `CodeSignAuthSignCertificateName`. They may reuse the Windows values only when the same identity is authorized for `CP-401337-Apple` and its Apple operations. The certificate variable identifies the request-signing certificate in Key Vault, not an Apple private key. The task receives Azure's built-in `System.AccessToken` through `SYSTEM_ACCESSTOKEN` and the production `ESRP_GATEWAY_API`; no user-created PAT or Apple password is needed by this flow. Keep private keys in Key Vault, restrict signed builds to trusted refs, and never log the access token. Existing `CSC_LINK`, `CSC_KEY_PASSWORD`, and `APPLE_*` credentials remain relevant to GitHub Actions but are explicitly cleared from Azure's application preparation and distribution packaging steps.

Azure macOS stages are `prepare app bundles -> archive -> ESRP Developer ID sign -> verify signatures -> ESRP notarize -> staple and verify -> package -> validate final assets -> publish`. Each architecture has its own exact `Huabu.zip` input, with `Huabu.app` at the ZIP root and symbolic links preserved by `zip -r -y`. Temporary preparation uses electron-builder's ad-hoc signing to establish Electron entitlements; ESRP must replace that with a timestamped Developer ID Application signature. Dedicated `EsrpAppleCodeSigning@1` tasks use `CP-401337-Apple`, `MacAppDeveloperSign`, and the documented `Hardening: Enable` / `codesign-options: enable` parameters. Separate notarization tasks use `MacAppDeveloperNotarize`, empty parameters, and a 45-minute notarization timeout, following the supplied dedicated-task example rather than the older `MacAppNotarize` configuration.

[esrp-macos.mjs](../../apps/desktop/scripts/esrp-macos.mjs) expects the signing task to replace each input ZIP in place and fails if the ZIP bytes are unchanged or the extracted application is not correctly signed. This return-path contract and the configured operation permissions require an authenticated Azure trial; they are not established by local tests. The script verifies the `com.huabu.app` identifier, CPU architecture, Developer ID authority, signing timestamp, hardened runtime, and matching signing teams across architectures. It requires JIT entitlements on the application and renderer helper and rejects enabled debugging entitlements. Notarization output is extracted from the corresponding ZIP; if a ticket is not already attached, the script explicitly invokes `xcrun stapler staple`, then requires both ticket validation and Gatekeeper assessment to succeed. Missing output, unexpected signatures, missing entitlements, or failed notarization stop publication.

Final DMG/ZIP generation uses electron-builder's `prepackaged` mode with local signing and notarization disabled so that the verified application is not re-signed. The script verifies the application again after packaging, inside the extracted final ZIP, and inside a read-only mounted DMG. These checks cover the application and its attached ticket; the DMG container is not separately ESRP-signed or notarized. Per-architecture packaging generates fresh blockmaps and update metadata, which are combined into one `latest-mac.yml` only after all asset sizes and SHA-512 hashes match. Temporary signing ZIPs and ad-hoc bundles stay outside the publication directory. Run `node --test apps/desktop/scripts/esrp-macos.test.mjs` for portable checks; a macOS Azure run is still required to validate Apple tools, ESRP return behavior, Electron launch, and upgrade compatibility if the Developer ID team differs from previous releases.

Both jobs validate the release workflow's required assets listed above, then publish the entire `$(Build.SourcesDirectory)/../huabu-electron-out` directory as Azure Pipeline artifacts named `huabu-windows` and `huabu-macos`. Download them from the pipeline run's **Artifacts** section. Uploading the entire directory preserves installer filenames, update metadata, blockmaps, and any additional output without filtering.

Windows uses the standard `EsrpCodeSigning@6` task with WIF/MSI authentication. Configure `CodeSignAuthSignCertificateName` (request-signing certificate), `CodeSignAppRegistrationTenantId` (the task's application registration tenant ID), `CodeSignAppRegistrationClientId` (the task's application registration client ID), `CodeSignEsrpClientId` (ESRP-registered application client ID), `CodeSignConnectedServiceName` (onboarded service connection), and `CodeSignKeyVaultName` in Azure DevOps. No values for those settings are stored in the repository. The task handles service-connection authentication and client execution; there is no custom WIF/token handling, task-cache discovery, CLI adapter, or extra user-configured signing variable. Authorize the service connection for this pipeline and ensure the ESRP application can use `CP-230012` for `SigntoolSign` and `SigntoolVerify`. Do not grant signing access to untrusted refs.

The Windows job runs the existing `pnpm run build:desktop:win` command unchanged, then signs only `Huabu-Setup-<version>.exe`. `FolderPath` is `$(Build.SourcesDirectory)/../huabu-electron-out`; `Pattern` is the exact installer basename derived from the validated release version, with minimatch enabled. It is not a recursive EXE/DLL wildcard. The task uses `CP-230012`, SHA-256, an RFC 3161 timestamp, and a verification operation. A subsequent PowerShell step requires a valid timestamped Authenticode signature and changed installer bytes before preparing the release assets. There are no electron-builder signing hooks, background workers, receipts, or file handshakes.

This is intentionally an **installer-only signing milestone**, not full application signing. The embedded application, NSIS elevation helper, generated uninstaller, and third-party binaries are not submitted to ESRP. Their existing electron-builder behavior and any upstream signatures are unchanged; signing the outer installer does not sign its embedded executables. The normal `app-update.yml` generation is unchanged, and this milestone does not inject or claim an ESRP-verified application publisher. Completing application/uninstaller signing is separate work.

Post-build signing changes the installer after electron-builder has generated its update hashes and blockmap. [esrp-release.mjs](../../apps/desktop/scripts/esrp-release.mjs) therefore regenerates the external `.exe.blockmap` using the installed electron-builder implementation and updates the SHA-512 and size in `latest.yml`, preserving release notes, date, and other existing fields. It rejects unexpected versions, filenames, or multi-file layouts instead of modifying unrelated assets. It does not sign files or handle credentials. Only after signature verification and metadata refresh succeed does the pipeline publish the complete output directory.

The Windows pipeline runs `node --test apps/desktop/scripts/esrp-release.test.mjs` after dependency installation. Tests cover metadata regeneration after simulated signing, untouched application bytes, preservation of release fields, rejection of unexpected assets, the official task's variable mapping and narrow signing pattern, and signature-gate failure cases. Local tests do not establish ESRP authorization: an authenticated Azure run is still required to confirm WIF access, policy entitlement, and real timestamped signatures. Publish the signed installer together with its refreshed update metadata and blockmap; never pair it with pre-sign hashes. Local and GitHub builds and installation options are unchanged; only Azure macOS packaging switches to the dedicated Apple ESRP flow.

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
| [apps/desktop/scripts/esrp-release.mjs](../../apps/desktop/scripts/esrp-release.mjs)                                                 | Refreshes Windows installer update hashes and blockmap after the official ESRP task signs it.                      |
| [apps/desktop/scripts/esrp-macos.mjs](../../apps/desktop/scripts/esrp-macos.mjs)                                                     | Prepares Apple signing archives, verifies signatures and tickets, and packages verified macOS releases.            |
| [apps/desktop/electron-builder.esrp.yml](../../apps/desktop/electron-builder.esrp.yml)                                               | Azure-only application preparation overlay; local and GitHub packaging retain the base configuration.              |
| [.github/workflows/nightly.yml](../../.github/workflows/nightly.yml)                                                                 | Builds nightly mac + win assets with the same feed and completeness contract.                                      |
