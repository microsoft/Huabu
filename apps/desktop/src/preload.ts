/**
 * Preload script — runs in an isolated context with access to both
 * the DOM and a limited set of Node.js APIs.
 *
 * We keep this minimal: only version information is exposed via
 * contextBridge. All application logic goes through the HTTP API
 * (the BrowserWindow loads http://127.0.0.1:<port>), so there is
 * no need to bridge Node.js or Electron APIs into the renderer.
 */

import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('electronBridge', {
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  /** Flag for the web app to detect it is running inside Electron. */
  isElectron: true,
});
