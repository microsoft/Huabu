# Desktop Auto-Update Architecture

How the packaged Huabu desktop app detects, downloads, and installs new
releases via [`electron-updater`](https://www.electron.build/auto-update).

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

## The update feed is configuration, not code

electron-updater reads the GitHub owner/repo from `app-update.yml`, which electron-builder bakes into the app at build time from the `publish` block in [electron-builder.yml](../../apps/desktop/electron-builder.yml). Those values are **not hardcoded** — they come from the `HUABU_UPDATE_OWNER` / `HUABU_UPDATE_REPO` env vars, set from GitHub Actions repository **Variables** in [release.yml](../../.github/workflows/release.yml) and [nightly.yml](../../.github/workflows/nightly.yml). Both variables are required for every distributable build; the workflows fail before packaging when either is empty.

Local `pnpm dist` runs must provide both variables as well. electron-builder treats a missing `${env.*}` macro as an invalid configuration rather than producing an inert updater.

## Private build, public distribution

The source repository builds each platform and stages the complete asset set on its private GitHub Release. A workflow in the public distribution repository then mirrors those assets to a release with the same version and tag. The packaged app points at that public repository through `HUABU_UPDATE_OWNER` / `HUABU_UPDATE_REPO`; it never needs access to the private source release.

The relay must preserve every asset filename and upload the complete platform set before publishing the public release. In particular, `latest*.yml` refers to installers by filename, so renaming an installer during the relay breaks the feed. The source workflows validate each required asset category before uploading, but the public relay must enforce the same all-or-nothing publication rule.

## Release artifacts electron-updater requires

The `dist:*` scripts pass `--publish never`: electron-builder generates the update metadata but never publishes; `gh release upload` in the workflow does. For auto-update to work, the **release the app polls must carry the full set** (missing `latest*.yml` or the mac `.zip` silently breaks updates):

| Platform | Required release assets                          |
| -------- | ------------------------------------------------ |
| macOS    | `*.dmg`, `*.zip`, `*.blockmap`, `latest-mac.yml` |
| Windows  | `*.exe`, `*.exe.blockmap`, `latest.yml`          |

The `.dmg` / `.exe` are the human-facing first installs; the `.zip`
(Squirrel.Mac) and `latest*.yml` feeds are what the running app consumes.
When a build is relocated from the build-source repo to the public
distribution repo, these metadata files must move with it.

## Code entry points

| File/dir                                                                                                                             | Responsibility                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [apps/desktop/src/updater.ts](../../apps/desktop/src/updater.ts)                                                                     | Main-process lifecycle, IPC handlers, status broadcast, periodic checks.      |
| [apps/desktop/src/main.ts](../../apps/desktop/src/main.ts)                                                                           | Registers updater IPC before first render; starts checks after window.        |
| [apps/desktop/src/preload.ts](../../apps/desktop/src/preload.ts)                                                                     | `electronBridge.updater` sandboxed bridge.                                    |
| [apps/desktop/electron-builder.yml](../../apps/desktop/electron-builder.yml)                                                         | `publish` feed (env-driven) + mac `zip` target for Squirrel.Mac.              |
| [apps/web/src/hooks/useElectron.ts](../../apps/web/src/hooks/useElectron.ts)                                                         | `UpdateStatus` type + `ElectronUpdaterApi` bridge types.                      |
| [apps/web/src/hooks/useAppUpdate.ts](../../apps/web/src/hooks/useAppUpdate.ts)                                                       | Renderer hook: subscribe to status, expose check/download/install.            |
| [apps/web/src/components/Shell/UpdateButton.tsx](../../apps/web/src/components/Shell/UpdateButton.tsx)                               | Header affordance rendering the update lifecycle.                             |
| [apps/web/src/components/Shell/WindowChrome.tsx](../../apps/web/src/components/Shell/WindowChrome.tsx)                               | Mounts `UpdateButton` next to Handbook / Settings.                            |
| [apps/web/src/components/Panels/Header/AppMenu.tsx](../../apps/web/src/components/Panels/Header/AppMenu.tsx)                         | Windows/Linux in-app “Check for Updates” command.                             |
| [apps/web/src/components/Settings/sections/GeneralSettings.tsx](../../apps/web/src/components/Settings/sections/GeneralSettings.tsx) | Settings check command and current-version status.                            |
| [apps/web/src/components/Shell/NativeMenuBridge.tsx](../../apps/web/src/components/Shell/NativeMenuBridge.tsx)                       | Maps the macOS native check command to `useAppUpdate`.                        |
| [apps/desktop/src/mac-menu.ts](../../apps/desktop/src/mac-menu.ts)                                                                   | Builds the macOS native application-menu command.                             |
| [.github/workflows/release.yml](../../.github/workflows/release.yml)                                                                 | Builds mac + win, uploads installers + update metadata to the release.        |
| [.github/workflows/nightly.yml](../../.github/workflows/nightly.yml)                                                                 | Builds nightly mac + win assets with the same feed and completeness contract. |
