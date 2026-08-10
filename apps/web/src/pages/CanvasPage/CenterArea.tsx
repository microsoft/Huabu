// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Bot, BookOpen } from 'lucide-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsPopover } from '@/components/Settings/SettingsPopover';

import { Button } from '../../components/Common/Button';
import { cn } from '../../components/Common/cn';
import { Canvas } from '../../components/Panels/Canvas/Canvas';
import { openUserHandbook } from '../../config/handbook';
import { isElectron } from '../../hooks/useElectron';

/** Hosts the Canvas and its floating controls. */
type CenterAreaProps = {
  canvasShortcutsDisabled?: boolean;
  /**
   * Mirrors the chat (right) panel collapse state. Injected by MainLayout
   * so the floating chat-toggle button can live on top of the canvas
   * instead of as a vertical strip at the canvas edge.
   */
  isChatCollapsed?: boolean;
  onToggleChat?: () => void;
};

export const CenterArea: React.FC<CenterAreaProps> = ({
  canvasShortcutsDisabled = false,
  isChatCollapsed,
  onToggleChat,
}) => {
  const { t } = useTranslation();

  // The custom Electron title bar already exposes Handbook + Settings
  // globally — suppress the duplicate floating versions on the canvas
  // when running inside the desktop shell.
  const isElectronApp = isElectron();

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      {/* Canvas – always mounted; width controlled via CSS. Hosts the
          floating top-right controls so they pin to the canvas's right
          edge (not the whole CenterArea) — in split mode the buttons
          stay over the canvas portion instead of bleeding into the
          expanded preview panel on the right. */}
      <div className="relative h-full w-full overflow-hidden">
        <Canvas shortcutsDisabled={canvasShortcutsDisabled} />

        {/* Floating top-right controls — in the browser these host the
            Handbook / Settings / Chat-toggle group. In Electron the
            first two move up to the custom title bar (WindowChrome)
            so only the canvas-specific chat toggle stays here, and
            the tooltips of the remaining button can flow upward as
            usual without being clipped by the title bar above.
            All visible buttons use the pill shape so they read as a
            uniform floating control group on top of the canvas. */}
        <div className="pointer-events-auto absolute top-3 right-2 z-30 flex items-center gap-1">
          {!isElectronApp && (
            <>
              {/* Handbook — opens the external site in a new browser tab so
                  the canvas session stays intact while users reference it. */}
              <Button
                variant="ghost"
                shape="pill"
                size="lg"
                iconOnly
                onClick={openUserHandbook}
                title={t('navigation.userHandbook')}
                aria-label={t('navigation.openUserHandbook')}
              >
                <BookOpen />
              </Button>
              <SettingsPopover variant="ghost" shape="pill" size="lg" />
            </>
          )}
          {onToggleChat && (
            <Button
              variant="outline"
              shape="pill"
              iconOnly
              size="lg"
              onClick={onToggleChat}
              title={isChatCollapsed ? t('chat.open') : t('chat.close')}
              tooltipPlacement="bottom"
              aria-label={
                isChatCollapsed ? t('chat.openPanel') : t('chat.closePanel')
              }
              aria-pressed={!isChatCollapsed}
              className={cn(
                // Active state mirrors the CanvasToolbar's active button —
                // icon switches to the theme info color over a soft
                // info-tinted background so the toggle reads as
                // "currently engaged" without the heavy solid look.
                !isChatCollapsed &&
                  'text-info bg-info-bg border-info-light enabled:hover:bg-info-bg-hover',
              )}
            >
              <Bot />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
