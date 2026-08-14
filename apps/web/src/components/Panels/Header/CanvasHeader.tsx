// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { ListIndentDecrease, ListIndentIncrease } from 'lucide-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

import { AppMenu } from './AppMenu.tsx';
import { CanvasMenu } from './CanvasMenu.tsx';
import { Button } from '../../Common/Button';

interface CanvasHeaderProps {
  children?: React.ReactNode;
  /**
   * When true, the header switches to a detached "floating" card variant
   * (used when MainLayout's left panel is collapsed). The full header
   * content is still rendered — only the chrome differs.
   */
  isCollapsed?: boolean;
  /**
   * Toggles the left panel. Injected by MainLayout so the collapse control
   * can live inside the header instead of the panel body.
   */
  onToggle?: () => void;
  /**
   * Uses a smaller logo (`h-6 w-6`) suited for in-canvas use. The default
   * (`h-8 w-8`) is used on standalone pages such as the canvas list.
   */
  compact?: boolean;
  vertical?: boolean;
  /**
   * Opens the Keyboard Shortcuts modal. Forwarded to the default
   * `<CanvasMenu />` so the dropdown can host the entry alongside
   * Undo / Redo / Export.
   */
  onOpenShortcuts?: () => void;
}

/**
 * Header variant used inside the canvas editor. Lives at the top of the left
 * column when the layers panel is expanded; switches to a floating card that
 * overlays the canvas when the layers panel is collapsed.
 */
export const CanvasHeader: React.FC<CanvasHeaderProps> = ({
  children,
  isCollapsed,
  onToggle,
  compact = false,
  vertical = false,
  onOpenShortcuts,
}) => {
  const { t } = useTranslation();
  // The desktop title bar (`WindowChrome`) shows a Home button for
  // back-to-list navigation; here the logo hosts the workspace-level
  // `AppMenu` (new / import canvas, switch workspace, settings, …), so
  // the two affordances no longer duplicate each other.
  return (
    <header
      className={clsx(
        'bg-surface flex items-center gap-1 overflow-hidden',
        // In-column variant connects to the left panel below via shared
        // borders. Floating variant matches the CanvasToolbar chrome
        // (soft bottom shadow, no border, lg-rounded card) and caps its
        // width so long canvas titles don't stretch the overlay across
        // the canvas.
        vertical
          ? 'border-edge-default h-full w-12 flex-col border-r px-2 py-1'
          : isCollapsed
            ? 'shadow-bottom h-10 max-w-[18rem] rounded-lg border-0'
            : 'border-edge-default h-12 border-r border-b',
        !vertical && 'px-2',
      )}
    >
      {!vertical && (
        <>
          <AppMenu compact={compact} />

          <div className="min-w-0 flex-1">
            {children ?? <CanvasMenu onOpenShortcuts={onOpenShortcuts} />}
          </div>
        </>
      )}

      {onToggle && (
        <Button
          variant="ghost"
          iconOnly
          onClick={onToggle}
          title={isCollapsed ? t('layers.show') : t('layers.collapse')}
          aria-label={
            isCollapsed ? t('layers.showPanel') : t('layers.collapsePanel')
          }
        >
          {isCollapsed ? (
            <ListIndentIncrease size={16} />
          ) : (
            <ListIndentDecrease size={16} />
          )}
        </Button>
      )}
    </header>
  );
};
