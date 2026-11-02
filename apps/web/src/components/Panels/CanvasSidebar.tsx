// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
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
        <div className="flex shrink-0 gap-1 px-3 pb-2">
          <Button
            size="sm"
            variant="ghost"
            tone={mode === 'layers' ? 'info' : 'neutral'}
            aria-pressed={mode === 'layers'}
            onClick={() => setMode('layers')}
          >
            {t('layers.title')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            tone={mode === 'files' ? 'info' : 'neutral'}
            aria-pressed={mode === 'files'}
            onClick={() => setMode('files')}
          >
            {t('files.title')}
          </Button>
        </div>
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
