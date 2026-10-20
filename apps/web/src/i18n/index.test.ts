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
    localStorage.setItem('huabu.language', language);
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

it.each([
  ['en', 'zh-CN'],
  ['zh-CN', 'en'],
])(
  'keeps current language %s when a stale %s event arrives',
  async (current, stale) => {
    await i18n.changeLanguage(current);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'huabu.language',
        newValue: stale,
      }),
    );
    await vi.waitFor(() => expect(i18n.language).toBe(current));
    expect(localStorage.getItem('huabu.language')).toBe(current);
    expect(mocks.write).not.toHaveBeenCalled();
  },
);

it.each([null, 'unsupported'])(
  'does not apply a stale language when the current stored value is %s',
  async (current) => {
    if (current === null) localStorage.removeItem('huabu.language');
    else localStorage.setItem('huabu.language', current);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'huabu.language',
        newValue: 'zh-CN',
      }),
    );
    await vi.waitFor(() => expect(i18n.language).toBe('en'));
    expect(localStorage.getItem('huabu.language')).toBe(current);
    expect(mocks.write).not.toHaveBeenCalled();
  },
);
