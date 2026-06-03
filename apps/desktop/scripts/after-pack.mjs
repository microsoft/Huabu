/**
 * electron-builder afterPack hook.
 *
 * Ensures the bundled `agentlet` shell script is executable after being
 * copied into the app's Resources directory. electron-builder does not
 * preserve executable permissions from extraResources on all platforms.
 */
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** @param {{ appOutDir: string, electronPlatformName: string, packager: { appInfo: { productFilename: string } } }} context */
export default async function afterPack(context) {
  const isMac = context.electronPlatformName === 'darwin';
  const productName = context.packager.appInfo.productFilename;
  const agentletPath = isMac
    ? join(
        context.appOutDir,
        `${productName}.app`,
        'Contents',
        'Resources',
        'agentlet',
      )
    : join(context.appOutDir, 'resources', 'agentlet');

  if (existsSync(agentletPath)) {
    chmodSync(agentletPath, 0o755);

    console.log('[afterPack] chmod +x agentlet ✓');
  } else {
    console.warn(`[afterPack] agentlet not found at ${agentletPath}`);
  }
}
