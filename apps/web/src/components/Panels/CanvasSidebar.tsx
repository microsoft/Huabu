// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { TabGroup } from '@/components/Common/TabGroup';
import { usePanelStore } from '@/store/panelStore';

import { CanvasLayerPanel } from './CanvasLayerPanel';
import { FilesPanel } from './FilesPanel';

export function CanvasSidebar({
  isCollapsed,
  isContentMounted = true,
  onToggle,
}: {
  isCollapsed?: boolean;
  isContentMounted?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  const mode = usePanelStore((state) => state.leftMode);
  const setMode = usePanelStore((state) => state.setLeftMode);
  return (
    <div className="bg-surface flex h-full min-h-0 flex-col">
      {!isCollapsed ? (
        <TabGroup
          size="sm"
          aria-label={t('layers.sidebarViews')}
          className="shrink-0 px-2 pb-1.5"
          options={[
            { value: 'layers', label: t('layers.title') },
            { value: 'files', label: t('files.title') },
          ]}
          value={mode}
          onChange={setMode}
        />
      ) : null}
      <div className={mode === 'layers' ? 'min-h-0 flex-1' : 'hidden'}>
        <CanvasLayerPanel
          isCollapsed={isCollapsed}
          isContentMounted={isContentMounted && mode === 'layers'}
          onToggle={onToggle}
        />
      </div>
      {mode === 'files' && !isCollapsed && isContentMounted ? (
        <FilesPanel />
      ) : null}
    </div>
  );
}
