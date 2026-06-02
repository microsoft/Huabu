import React from 'react';

import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { Toggle } from '@/components/Common/Toggle';
import useCanvasStore from '@/store/canvasStore';

export const CanvasSettings: React.FC = () => {
  const autoLayoutEnabled = useCanvasStore((s) => s.autoLayoutEnabled);
  const toggleAutoLayout = useCanvasStore((s) => s.toggleAutoLayout);

  return (
    <SettingSection title="Canvas">
      <SettingRow
        title="Auto Layout"
        description="Automatically resize frame nodes to fit their content."
      >
        <Toggle
          checked={autoLayoutEnabled}
          onChange={() => toggleAutoLayout()}
          label={
            autoLayoutEnabled ? 'Disable Auto Layout' : 'Enable Auto Layout'
          }
        />
      </SettingRow>
    </SettingSection>
  );
};
