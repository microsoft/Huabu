import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import enCommon from './resources/en/common.json';
import zhCNCommon from './resources/zh-CN/common.json';

export const supportedLngs = ['en', 'zh-CN'] as const;
export type SupportedLanguage = (typeof supportedLngs)[number];

export const defaultNS = 'common';

void i18n
  .use(LanguageDetector)
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
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: 'sediment.language',
      convertDetectedLanguage: (lng) =>
        lng.toLowerCase().startsWith('zh') ? 'zh-CN' : lng,
    },
    react: {
      useSuspense: false,
    },
  });

export { i18n };
