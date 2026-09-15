// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { isSameOrigin, type BasicAuthCredentials } from './server-target.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isRemoteBasicAuthChallenge(
  requestUrl: string,
  authInfo: { isProxy: boolean; scheme: string },
  serverOrigin: string,
): boolean {
  return (
    !authInfo.isProxy &&
    authInfo.scheme.toLowerCase() === 'basic' &&
    isSameOrigin(requestUrl, serverOrigin)
  );
}

export function promptForRemoteBasicAuth(
  serverOrigin: string,
  realm: string,
  parent: BrowserWindow | null,
  isRetry: boolean,
): Promise<BasicAuthCredentials | undefined> {
  return new Promise((resolve) => {
    const prompt = new BrowserWindow({
      width: 420,
      height: 300,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: 'Sign in to Huabu Server',
      ...(parent?.isVisible() ? { parent, modal: true } : {}),
      webPreferences: {
        preload: join(__dirname, 'auth-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
      },
    });

    let settled = false;
    const finish = (credentials?: BasicAuthCredentials): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('remote-basic-auth:submit', onSubmit);
      ipcMain.removeListener('remote-basic-auth:cancel', onCancel);
      if (!prompt.isDestroyed()) prompt.close();
      resolve(credentials);
    };
    const onSubmit = (event: Electron.IpcMainEvent, value: unknown): void => {
      if (event.sender !== prompt.webContents) return;
      if (!value || typeof value !== 'object') return;
      const input = value as Record<string, unknown>;
      if (
        typeof input.username !== 'string' ||
        typeof input.password !== 'string'
      ) {
        return;
      }
      finish({ username: input.username, password: input.password });
    };
    const onCancel = (event: Electron.IpcMainEvent): void => {
      if (event.sender === prompt.webContents) finish();
    };

    ipcMain.on('remote-basic-auth:submit', onSubmit);
    ipcMain.on('remote-basic-auth:cancel', onCancel);
    prompt.on('closed', () => finish());
    prompt.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    prompt.webContents.on('will-navigate', (event) => event.preventDefault());
    prompt.once('ready-to-show', () => {
      prompt.show();
      prompt.focus();
    });

    const safeOrigin = escapeHtml(serverOrigin);
    const safeRealm = escapeHtml(realm || 'Huabu');
    const retryMessage = isRetry
      ? '<p role="alert" class="error">The username or password was not accepted. Try again.</p>'
      : '';
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>Sign in to Huabu Server</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 24px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { color: #666; font-size: 13px; margin: 0 0 18px; overflow-wrap: anywhere; }
    .error { color: #b42318; font-weight: 600; }
    label { display: block; font-size: 13px; margin: 12px 0 4px; }
    input { box-sizing: border-box; width: 100%; padding: 8px; }
    footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
    button { padding: 7px 16px; }
  </style>
</head>
<body>
  <h1>Sign in to Huabu Server</h1>
  <p>${safeOrigin}<br>Realm: ${safeRealm}</p>
  ${retryMessage}
  <form id="form">
    <label for="username">Username</label>
    <input id="username" autocomplete="username" autofocus>
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password">
    <footer>
      <button id="cancel" type="button">Cancel</button>
      <button type="submit">Sign in</button>
    </footer>
  </form>
  <script>
    document.getElementById('form').addEventListener('submit', (event) => {
      event.preventDefault();
      window.remoteBasicAuth.submit(
        document.getElementById('username').value,
        document.getElementById('password').value,
      );
    });
    document.getElementById('cancel').addEventListener('click', () => {
      window.remoteBasicAuth.cancel();
    });
  </script>
</body>
</html>`;
    void prompt.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
  });
}

export function registerRemoteBasicAuth(
  serverOrigin: string,
  getParentWindow: () => BrowserWindow | null,
  onCancelled: () => void,
  initialCredentials?: BasicAuthCredentials,
): void {
  let pendingPrompt: Promise<BasicAuthCredentials | undefined> | null = null;
  let promptCount = initialCredentials ? 1 : 0;
  let cancellationHandled = false;
  let navigationCredentials = initialCredentials;

  app.on('login', (event, _webContents, requestDetails, authInfo, callback) => {
    if (
      !isRemoteBasicAuthChallenge(requestDetails.url, authInfo, serverOrigin)
    ) {
      return;
    }

    event.preventDefault();
    if (navigationCredentials) {
      const credentials = navigationCredentials;
      navigationCredentials = undefined;
      callback(credentials.username, credentials.password);
      return;
    }
    if (!pendingPrompt) {
      pendingPrompt = promptForRemoteBasicAuth(
        serverOrigin,
        authInfo.realm,
        getParentWindow(),
        promptCount > 0,
      ).finally(() => {
        pendingPrompt = null;
      });
      promptCount += 1;
    }
    void pendingPrompt.then((credentials) => {
      if (credentials) {
        callback(credentials.username, credentials.password);
      } else {
        callback();
        if (!cancellationHandled) {
          cancellationHandled = true;
          onCancelled();
        }
      }
    });
  });
}
