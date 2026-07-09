import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Select } from '@/components/Common/Select';
import { SettingRow } from '@/components/Common/SettingRow';
import { supportedLngs, type SupportedLanguage } from '@/i18n';

/** Native language names, shown regardless of the active UI language. */
const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: 'English',
  'zh-CN': '简体中文',
};

const LANGUAGE_OPTIONS = supportedLngs.map((lng) => ({
  value: lng,
  label: LANGUAGE_LABELS[lng],
}));

/**
 * General application settings. Currently exposes UI language selection.
 * Changing the language persists to `localStorage` (`sediment.language`)
 * via i18next's language detector cache, so it survives reloads.
 *
 * Renders a single bare {@link SettingRow}; the parent supplies the card
 * wrapper so the General tab shows one flat list (language + about) rather
 * than redundant one-row subsections.
 */
export const GeneralSettings: React.FC = () => {
  const { t, i18n } = useTranslation();

  const current = (i18n.resolvedLanguage ?? i18n.language) as SupportedLanguage;

  const handleChange = useCallback(
    (value: SupportedLanguage) => {
      void i18n.changeLanguage(value);
    },
    [i18n],
  );

  return (
    <SettingRow
      title={t('settings.language')}
      description={t('settings.languageDescription')}
    >
      <Select
        options={LANGUAGE_OPTIONS}
        value={current}
        onChange={handleChange}
        title={t('settings.language')}
      />
    </SettingRow>
  );
};
