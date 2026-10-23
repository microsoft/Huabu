// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import {
  readApplicationPreference,
  subscribeApplicationPreferences,
} from '@/utils/desktopStorage';

import enCommon from './resources/en/common.json';
import zhCNCommon from './resources/zh-CN/common.json';

export const supportedLngs = ['en', 'zh-CN'] as const;
export type SupportedLanguage = (typeof supportedLngs)[number];

export const defaultNS = 'common';

const detector = new LanguageDetector();
detector.addDetector({
  name: 'applicationPreference',
  lookup: () => readApplicationPreference('huabu.language') ?? undefined,
});
const desktop = typeof window !== 'undefined' && !!window.electronBridge?.tabs;

void i18n
  .use(detector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon },
      'zh-CN': { common: zhCNCommon },
    },
    fallbackLng: 'en',
    supportedLngs,
    defaultNS,
    ns: [defaultNS],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['applicationPreference', 'navigator', 'htmlTag'],
      caches: desktop ? [] : ['localStorage'],
      lookupLocalStorage: 'huabu.language',
      convertDetectedLanguage: (lng) =>
        lng.toLowerCase().startsWith('zh') ? 'zh-CN' : lng,
    },
    react: {
      useSuspense: false,
    },
  });

export { i18n };

subscribeApplicationPreferences((key) => {
  if (key !== 'huabu.language') return;
  const language = readApplicationPreference(key);
  if (language && supportedLngs.some((supported) => supported === language))
    void i18n.changeLanguage(language);
});
