import React from 'react';

import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { Toggle } from '@/components/Common/Toggle';
import useCanvasStore from '@/store/canvasStore';

export const CanvasSettings: React.FC = () => {
  const autoLayoutEnabled = useCanvasStore((s) => s.autoLayoutEnabled);
  const toggleAutoLayout = useCanvasStore((s) => s.toggleAutoLayout);
  const minimapEnabled = useCanvasStore((s) => s.minimapEnabled);
  const toggleMinimap = useCanvasStore((s) => s.toggleMinimap);

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
      <SettingRow
        title="Show MiniMap"
        description="Display an overview of the canvas in the bottom-right corner."
      >
        <Toggle
          checked={minimapEnabled}
          onChange={() => toggleMinimap()}
          label={minimapEnabled ? 'Hide MiniMap' : 'Show MiniMap'}
        />
      </SettingRow>
    </SettingSection>
  );
};
