import { Settings } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsModal } from './SettingsModal';
import { Button } from '../../Common/Button';

import type { TooltipPlacement } from '../../Common/Tooltip';

interface SettingsPopoverProps {
  /**
   * Visual style of the trigger button. Defaults to `ghost` to match the
   * in-chat header. Pass `outline` / `pill` to render as a circular outline
   * button (matches the floating top-right canvas controls).
   */
  variant?: 'ghost' | 'outline';
  shape?: 'default' | 'pill';
  size?: 'sm' | 'md' | 'lg';
  /**
   * Override the tooltip placement on the trigger button. Defaults to
   * `'auto'` (above with flip-to-bottom fallback). Pass `'bottom'` when
   * the trigger lives at the top edge of the window — e.g. inside the
   * Electron custom title bar — where there is no room above.
   */
  tooltipPlacement?: TooltipPlacement;
}

/**
 * Settings trigger — a gear button that opens the tabbed {@link SettingsModal}.
 * Kept as `SettingsPopover` so the three call sites (Electron title bar,
 * web header, canvas floating controls) don't need to change.
 */
export const SettingsPopover: React.FC<SettingsPopoverProps> = ({
  variant = 'ghost',
  shape = 'default',
  size = 'md',
  tooltipPlacement,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button
        variant={variant}
        shape={shape}
        size={size}
        iconOnly
        title={t('settings.title')}
        tooltipPlacement={tooltipPlacement}
        onClick={() => setIsOpen(true)}
        aria-label={t('settings.open')}
      >
        <Settings />
      </Button>

      <SettingsModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
};
