// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { InMemoryBubbleStore } from '@octostaff/bubble';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { openBubbleIdentity } from './bubble.js';
import { createMemoryWorkspacePreferences } from './preferences.js';
import { storageResourceDirectory } from './resources.js';

vi.mock('@fastify/websocket', () => ({
  default: async () => {
    throw new Error('websocket setup failed');
  },
}));

it.each([false, true])(
  'releases both identity connections after plugin setup fails (store close failure: %s)',
  async (closeFails) => {
    const closeStore = vi.fn(async () => {
      if (closeFails) throw new Error('store close failed');
    });
    const store = Object.assign(new InMemoryBubbleStore(), {
      close: closeStore,
    });
    const preferences = createMemoryWorkspacePreferences();
    const closePreferences = vi.spyOn(preferences, 'close');
    const identity = await openBubbleIdentity({
      authenticator: [{ driver: 'master-key', masterKey: 'test-master-key' }],
      store,
      preferences,
      resources: storageResourceDirectory,
    });
    const app = Fastify();
    app.register(identity.plugin, { prefix: '/bubble' });
    await expect(app.ready()).rejects.toThrow('websocket setup failed');
    if (closeFails)
      await expect(app.close()).rejects.toThrow('store close failed');
    else await app.close();
    expect(closeStore).toHaveBeenCalledOnce();
    expect(closePreferences).toHaveBeenCalledOnce();
  },
);
