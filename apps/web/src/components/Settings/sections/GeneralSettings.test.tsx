// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { GeneralSettings } from './GeneralSettings';

import type { SupportedLanguage } from '@/i18n';

const mocks = vi.hoisted(() => ({
  desktop: true,
  write: vi.fn(),
  changeLanguage: vi.fn(),
  toast: vi.fn(),
  selectLanguage: null as
    | null
    | ((language: SupportedLanguage) => Promise<void>),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: mocks.changeLanguage },
  }),
}));
vi.mock('@/i18n', () => ({ supportedLngs: ['en', 'zh-CN'] }));
vi.mock('@/utils/desktopStorage', () => ({
  writeApplicationPreference: mocks.write,
}));
vi.mock('@/components/Common/Toast', () => ({ toast: mocks.toast }));
vi.mock('@/components/Common/Select', () => ({
  Select: (props: {
    ariaLabel?: string;
    onChange: (language: SupportedLanguage) => Promise<void>;
  }) => {
    if (props.ariaLabel === 'settings.language')
      mocks.selectLanguage = props.onChange;
    return null;
  },
}));
vi.mock('@/components/Settings/CanaryRedeploySettings', () => ({
  CanaryRedeploySettings: () => null,
}));
vi.mock('@/hooks/useAppUpdate', () => ({
  useAppUpdate: () => ({ status: { state: 'idle' }, check: vi.fn() }),
  canCheckForUpdates: () => false,
}));
vi.mock('@/hooks/useElectron', () => ({
  getElectronBridge: () => (mocks.desktop ? { tabs: {} } : null),
}));
vi.mock('@/hooks/useInputMode', () => ({
  useEffectiveInputMode: () => 'mouse',
}));
vi.mock('@/store/canvasStore', () => ({
  default: (
    select: (state: {
      minimapEnabled: boolean;
      toggleMinimap: () => void;
    }) => unknown,
  ) => select({ minimapEnabled: false, toggleMinimap: vi.fn() }),
}));
vi.mock('@/store/toolStore', () => ({
  useToolStore: (
    select: (state: {
      inputModePreference: string;
      setInputModePreference: () => void;
    }) => unknown,
  ) => select({ inputModePreference: 'auto', setInputModePreference: vi.fn() }),
}));
vi.mock('@/store/workspaceStore', () => ({
  useWorkspaceStore: (
    select: (state: {
      worldEnabled: boolean;
      setWorldEnabled: () => void;
    }) => unknown,
  ) => select({ worldEnabled: false, setWorldEnabled: vi.fn() }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  mocks.desktop = true;
  mocks.write.mockReset();
  mocks.changeLanguage.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
  mocks.selectLanguage = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<GeneralSettings />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function selectLanguage(): Promise<void> {
  if (!mocks.selectLanguage)
    throw new Error('Language selector was not rendered');
  await act(async () => mocks.selectLanguage?.('zh-CN'));
}

it('persists an explicit user language choice before changing the local interface', async () => {
  await selectLanguage();
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
    'huabu.language',
    'zh-CN',
  );
  expect(mocks.changeLanguage).toHaveBeenCalledExactlyOnceWith('zh-CN');
  expect(mocks.write.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.changeLanguage.mock.invocationCallOrder[0],
  );
});

it('reports persistence failure without applying an uncommitted language change', async () => {
  const error = new Error('Disk full');
  mocks.write.mockImplementationOnce(() => {
    throw error;
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await selectLanguage();
  expect(mocks.changeLanguage).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith('Disk full', { tone: 'danger' });
  expect(log).toHaveBeenCalledWith(
    '[settings] Could not change language:',
    error,
  );
});

it('keeps browser language changes on the existing i18next caching path', async () => {
  mocks.desktop = false;
  await selectLanguage();
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.changeLanguage).toHaveBeenCalledExactlyOnceWith('zh-CN');
  expect(mocks.toast).not.toHaveBeenCalled();
});

it('changes browser language in memory when localStorage is unavailable', async () => {
  mocks.desktop = false;
  const blocked = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  const { createInstance } = await import('i18next');
  const { default: LanguageDetector } =
    await import('i18next-browser-languagedetector');
  const browserI18n = createInstance();
  await browserI18n.use(new LanguageDetector()).init({
    lng: 'en',
    resources: { en: { translation: {} }, 'zh-CN': { translation: {} } },
    detection: {
      caches: ['localStorage'],
      lookupLocalStorage: 'huabu.language',
    },
  });
  mocks.changeLanguage.mockImplementation((language: string) =>
    browserI18n.changeLanguage(language),
  );
  await selectLanguage();
  expect(blocked).toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
  expect(browserI18n.language).toBe('zh-CN');
  expect(mocks.toast).not.toHaveBeenCalled();
});

it('still reports browser i18next failures', async () => {
  mocks.desktop = false;
  const error = new Error('Language load failed');
  mocks.changeLanguage.mockRejectedValueOnce(error);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await selectLanguage();
  expect(mocks.toast).toHaveBeenCalledWith(error.message, { tone: 'danger' });
  expect(log).toHaveBeenCalledWith(
    '[settings] Could not change language:',
    error,
  );
});
