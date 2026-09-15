// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('remoteBasicAuth', {
  submit: (username: string, password: string): void => {
    ipcRenderer.send('remote-basic-auth:submit', { username, password });
  },
  cancel: (): void => {
    ipcRenderer.send('remote-basic-auth:cancel');
  },
});
