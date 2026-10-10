// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { PanelRight, Sparkles } from 'lucide-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Common/Button';
import { Canvas } from '../../components/Panels/Canvas/Canvas';

/** Hosts the Canvas and its floating controls. */
type CenterAreaProps = {
  canvasShortcutsDisabled?: boolean;
  isRightPanelCollapsed?: boolean;
  onToggleRightPanel?: () => void;
  onNewChat?: () => void | Promise<unknown>;
};

export const CenterArea: React.FC<CenterAreaProps> = ({
  canvasShortcutsDisabled = false,
  isRightPanelCollapsed = false,
  onToggleRightPanel,
  onNewChat,
}) => {
  const { t } = useTranslation();

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      {/* Canvas fills the work area; floating controls respect overlay insets. */}
      <div className="relative h-full w-full overflow-hidden">
        <Canvas shortcutsDisabled={canvasShortcutsDisabled} />

        {isRightPanelCollapsed && onToggleRightPanel && onNewChat && (
          <div className="bg-surface shadow-bottom pointer-events-auto absolute top-3 right-2 z-30 flex h-10 items-center gap-1 rounded-lg px-2">
            <Button
              variant="ghost"
              iconOnly
              size="md"
              className="text-fg-subtle enabled:hover:text-fg-default"
              onClick={() => onNewChat()}
              title={t('chat.newConversation')}
              tooltipPlacement="bottom"
            >
              <Sparkles aria-hidden />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              size="md"
              className="text-fg-subtle enabled:hover:text-fg-default"
              onClick={onToggleRightPanel}
              title={t('preview.expand')}
              tooltipPlacement="bottom"
            >
              <PanelRight aria-hidden />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
