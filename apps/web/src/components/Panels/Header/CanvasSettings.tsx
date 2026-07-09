import React from 'react';
import { useTranslation } from 'react-i18next';

import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { Toggle } from '@/components/Common/Toggle';
import useCanvasStore from '@/store/canvasStore';

export const CanvasSettings: React.FC = () => {
  const { t } = useTranslation();
  const minimapEnabled = useCanvasStore((s) => s.minimapEnabled);
  const toggleMinimap = useCanvasStore((s) => s.toggleMinimap);

  return (
    <SettingSection title={t('settings.canvas')} collapsible>
      <SettingRow
        title={t('settings.showMiniMap')}
        description={t('settings.miniMapDescription')}
      >
        <Toggle
          checked={minimapEnabled}
          onChange={() => toggleMinimap()}
          label={
            minimapEnabled
              ? t('settings.hideMiniMap')
              : t('settings.showMiniMap')
          }
        />
      </SettingRow>
    </SettingSection>
  );
};
