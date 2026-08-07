// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * electron-builder afterPack hook.
 *
 * Currently a no-op kept as a hook point: prior versions used this to
 * chmod +x the bundled `agentlet` shell wrapper. The wrapper is no
 * longer shipped (see `electron-builder.yml` `extraResources` and the
 * comment there explaining why), so there is nothing to fix up here.
 * Keeping the file (and the `afterPack:` reference in
 * `electron-builder.yml`) means re-introducing a per-platform
 * post-pack tweak later doesn't need a yml edit.
 *
 * When re-introducing logic, electron-builder calls this with a single
 * argument shaped roughly like:
 *   { appOutDir: string, electronPlatformName: string,
 *     packager: { appInfo: { productFilename: string } } }
 */
export default async function afterPack() {
  // No-op. See module-level docstring for context.
}
