// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, expect, it, vi } from 'vitest';

import { i18n } from './index';

const mocks = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('@/utils/desktopStorage', () => ({
  writeApplicationPreference: mocks.write,
}));

beforeEach(async () => {
  await i18n.changeLanguage('en');
  mocks.write.mockClear();
});

it('applies queued incoming language changes without sending them back to main', async () => {
  for (const language of ['zh-CN', 'en']) {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'huabu.language',
        newValue: language,
      }),
    );
  }
  await vi.waitFor(() => expect(i18n.language).toBe('en'));
  expect(localStorage.getItem('huabu.language')).toBe('en');
  expect(mocks.write).not.toHaveBeenCalled();
});
