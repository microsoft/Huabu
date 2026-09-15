// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
}));

import { isRemoteBasicAuthChallenge } from './remote-basic-auth';

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
