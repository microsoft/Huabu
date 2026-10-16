// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { app } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
}));

import {
  isRemoteBasicAuthChallenge,
  registerRemoteBasicAuth,
} from './remote-basic-auth';

it('reuses in-memory Basic credentials for each independent content renderer', () => {
  registerRemoteBasicAuth('https://huabu.example', () => null, vi.fn(), {
    username: 'user',
    password: 'password',
  });
  const listener = vi
    .mocked(app.on)
    .mock.calls.find(([event]) => event === 'login')?.[1];
  expect(listener).toBeDefined();
  const first = vi.fn();
  const second = vi.fn();
  for (const [id, callback] of [
    [1, first],
    [2, second],
  ] as const) {
    listener?.(
      { preventDefault: vi.fn() },
      { id },
      { url: 'https://huabu.example/api/workspace' },
      { isProxy: false, scheme: 'basic' },
      callback,
    );
    expect(callback).toHaveBeenCalledWith('user', 'password');
  }
});

describe('isRemoteBasicAuthChallenge', () => {
  it('accepts only Basic Auth challenges from the configured origin', () => {
    expect(
      isRemoteBasicAuthChallenge(
        'https://huabu.example/api/workspace',
        { isProxy: false, scheme: 'basic' },
        'https://huabu.example',
      ),
    ).toBe(true);
    expect(
      isRemoteBasicAuthChallenge(
        'https://huabu.example.attacker.test',
        { isProxy: false, scheme: 'basic' },
        'https://huabu.example',
      ),
    ).toBe(false);
    expect(
      isRemoteBasicAuthChallenge(
        'https://huabu.example',
        { isProxy: true, scheme: 'basic' },
        'https://huabu.example',
      ),
    ).toBe(false);
    expect(
      isRemoteBasicAuthChallenge(
        'https://huabu.example',
        { isProxy: false, scheme: 'digest' },
        'https://huabu.example',
      ),
    ).toBe(false);
  });
});
