import clsx from 'clsx';
import { ListIndentDecrease, ListIndentIncrease } from 'lucide-react';
import React from 'react';
import { Link } from 'react-router-dom';

import { CanvasMenu } from './CanvasMenu.tsx';
import { isElectron } from '../../../hooks/useElectron';
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
  onOpenShortcuts,
}) => {
  // In Electron the custom title bar (`WindowChrome`) already shows a Home
  // button, so we drop the in-canvas logo to avoid two side-by-side home
  // affordances when the layers panel is expanded.
  const isElectronApp = isElectron();

  return (
    <header
      className={clsx(
        'bg-surface flex items-center gap-1 overflow-hidden px-2',
        // In-column variant connects to the left panel below via shared
        // borders. Floating variant matches the CanvasToolbar chrome
        // (soft bottom shadow, no border, lg-rounded card) and caps its
        // width so long canvas titles don't stretch the overlay across
        // the canvas.
        isCollapsed
          ? 'shadow-bottom h-10 max-w-[18rem] rounded-lg border-0'
          : 'h-12 border-r border-b border-[#eeece7]',
      )}
    >
      {!isElectronApp && (
        <Link to="/" aria-label="Back to home" className="shrink-0">
          <img
            src="/favicon.svg"
            alt="Logo"
            className={compact ? 'h-6 w-6' : 'h-8 w-8'}
          />
        </Link>
      )}

      <div className="min-w-0 flex-1">
        {children ?? <CanvasMenu onOpenShortcuts={onOpenShortcuts} />}
      </div>

      {onToggle && (
        <Button
          variant="ghost"
          iconOnly
          onClick={onToggle}
          title={isCollapsed ? 'Show Layers' : 'Collapse Layers'}
          aria-label={
            isCollapsed ? 'Show layers panel' : 'Collapse layers panel'
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
