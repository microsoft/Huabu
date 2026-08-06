// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import enAgentTeam from './resources/en/agentTeam.json';
import enCommon from './resources/en/common.json';
import zhCNAgentTeam from './resources/zh-CN/agentTeam.json';
import zhCNCommon from './resources/zh-CN/common.json';

export const supportedLngs = ['en', 'zh-CN'] as const;
export type SupportedLanguage = (typeof supportedLngs)[number];

export const defaultNS = 'common';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon, agentTeam: enAgentTeam },
      'zh-CN': { common: zhCNCommon, agentTeam: zhCNAgentTeam },
    },
    fallbackLng: 'en',
    supportedLngs,
    defaultNS,
    ns: [defaultNS, 'agentTeam'],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: 'huabu.language',
      convertDetectedLanguage: (lng) =>
        lng.toLowerCase().startsWith('zh') ? 'zh-CN' : lng,
    },
    react: {
      useSuspense: false,
    },
  });

export { i18n };
