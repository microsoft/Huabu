// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { PanelLeft, PanelLeftClose } from 'lucide-react';
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
   * Uses a smaller logo (`h-5 w-5`) suited for in-canvas use. The default
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
        'bg-surface flex items-center overflow-hidden',
        vertical
          ? 'border-edge-default h-full w-12 flex-col gap-1 border-r px-2 py-2'
          : compact
            ? 'gap-0.5'
            : 'gap-1',
        !vertical &&
          (isCollapsed
            ? 'shadow-bottom h-10 max-w-[18rem] rounded-lg border-0 px-2'
            : compact
              ? 'border-edge-default h-11 border-r px-3'
              : 'border-edge-default h-12 border-r px-3 py-1'),
      )}
    >
      {!vertical && (
        <>
          <AppMenu
            compact={compact}
            logoClassName={compact ? 'h-5 w-5' : undefined}
            triggerClassName={compact ? 'h-6 w-6 p-0' : undefined}
          />

          <div className="min-w-0 flex-1">
            {children ?? <CanvasMenu onOpenShortcuts={onOpenShortcuts} />}
          </div>
        </>
      )}

      {onToggle && (
        <Button
          variant="ghost"
          iconOnly
          size={vertical ? 'md' : 'sm'}
          className="text-fg-subtle enabled:hover:text-fg-default"
          tooltipWrapperClassName={clsx(
            'inline-flex shrink-0',
            !vertical && (compact ? 'ml-2.5' : 'ml-2'),
          )}
          onClick={onToggle}
          title={isCollapsed ? t('layers.show') : t('layers.collapse')}
          aria-label={
            isCollapsed ? t('layers.showPanel') : t('layers.collapsePanel')
          }
        >
          {isCollapsed ? (
            <PanelLeft className="h-4! w-4!" />
          ) : (
            <PanelLeftClose className="h-4! w-4!" />
          )}
        </Button>
      )}
    </header>
  );
};
