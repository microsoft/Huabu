import React from 'react';
import { useTranslation } from 'react-i18next';

import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';

/**
 * "About" section for the General tab: app version and other static
 * product information. Extend with update channel, links, etc. later.
 */
export const AboutSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <SettingSection title={t('settings.about')}>
      <SettingRow title={t('settings.appVersion')}>
        <span className="text-fg-muted font-mono text-xs select-text">
          v{__APP_VERSION__}
        </span>
      </SettingRow>
    </SettingSection>
  );
};
