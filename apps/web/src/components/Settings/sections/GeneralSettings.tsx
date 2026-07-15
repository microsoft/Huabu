import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Select } from '@/components/Common/Select';
import { SettingRow } from '@/components/Common/SettingRow';
import { Toggle } from '@/components/Common/Toggle';
import { supportedLngs, type SupportedLanguage } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';

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
 * General application settings. Language changes persist to `localStorage`
 * (`sediment.language`) via i18next's language detector cache, while the
 * canvas store persists the minimap preference independently.
 *
 * Renders bare {@link SettingRow} entries; the parent supplies the card
 * wrapper so the General tab shows one flat list rather than redundant
 * one-row subsections.
 */
export const GeneralSettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const minimapEnabled = useCanvasStore((s) => s.minimapEnabled);
  const toggleMinimap = useCanvasStore((s) => s.toggleMinimap);

  const current = (i18n.resolvedLanguage ?? i18n.language) as SupportedLanguage;

  const handleChange = useCallback(
    (value: SupportedLanguage) => {
      void i18n.changeLanguage(value);
    },
    [i18n],
  );

  return (
    <>
      <SettingRow
        title={t('settings.language')}
        description={t('settings.languageDescription')}
      >
        <Select
          options={LANGUAGE_OPTIONS}
          value={current}
          onChange={handleChange}
          title={t('settings.language')}
          ariaLabel={t('settings.language')}
        />
      </SettingRow>
      <SettingRow
        title={t('settings.showMiniMap')}
        description={t('settings.miniMapDescription')}
      >
        <Toggle
          checked={minimapEnabled}
          onChange={toggleMinimap}
          label={
            minimapEnabled
              ? t('settings.hideMiniMap')
              : t('settings.showMiniMap')
          }
        />
      </SettingRow>
    </>
  );
};
