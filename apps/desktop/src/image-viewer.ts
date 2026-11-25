// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { BrowserWindow, type WebContents } from 'electron';

/**
 * Show one of the local Server's images in a window of its own.
 *
 * The system browser cannot show it: the Server admits only this app's
 * windows, and the launch token that proves it must not travel in a URL. The
 * window shares the opener's session, which carries the token, and gets no
 * preload bridge and nowhere else to go.
 */
export function openImageViewer(url: string, opener: WebContents): void {
  const parent = BrowserWindow.fromWebContents(opener) ?? undefined;
  const viewer = new BrowserWindow({
    ...(parent ? { parent } : {}),
    width: 1000,
    height: 760,
    title: 'Huabu',
    backgroundColor: '#1f1f1f',
    autoHideMenuBar: true,
    webPreferences: {
      session: opener.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  viewer.webContents.on('will-navigate', (event) => event.preventDefault());
  void viewer.loadURL(url).catch((error: unknown) => {
    console.error('[desktop] Could not show image:', error);
    if (!viewer.isDestroyed()) viewer.close();
  });
}
