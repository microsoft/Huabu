import { Settings } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';

import { AcpSettings } from './AcpSettings';
import { CanvasSettings } from './CanvasSettings';
import { LLMSettings } from './LLMSettings';
import { useAcpPairingStore } from '../../../store/acpPairingStore';
import { useLLMStore } from '../../../store/llmStore';
import { Button } from '../../Common/Button';
import { Popover } from '../../Common/Popover';

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
 * Settings popover. Currently only exposes LLM provider/model configuration.
 * Workspace switching lives on the home page (`/` and `/setup`).
 */
export const SettingsPopover: React.FC<SettingsPopoverProps> = ({
  variant = 'ghost',
  shape = 'default',
  size = 'md',
  tooltipPlacement,
}) => {
  const llmInit = useLLMStore((s) => s.init);
  const acpInit = useAcpPairingStore((s) => s.init);

  const [isOpen, setIsOpen] = useState(false);

  const triggerRef = useRef<HTMLDivElement>(null);
  const justDismissedRef = useRef(false);

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  const handleDismiss = useCallback(() => {
    justDismissedRef.current = true;
    handleClose();
    requestAnimationFrame(() => {
      justDismissedRef.current = false;
    });
  }, [handleClose]);

  const handleToggle = useCallback(() => {
    if (justDismissedRef.current) return;
    setIsOpen((prev) => {
      const next = !prev;
      if (next) {
        void llmInit();
        void acpInit();
      }
      return next;
    });
  }, [acpInit, llmInit]);

  const getPopoverPosition = () => {
    if (!triggerRef.current) return { x: 0, y: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    return { x: rect.right, y: rect.bottom };
  };

  return (
    <>
      <div ref={triggerRef}>
        <Button
          variant={variant}
          shape={shape}
          size={size}
          iconOnly
          title="Settings"
          tooltipPlacement={tooltipPlacement}
          onClick={handleToggle}
          aria-label="Open settings"
        >
          <Settings />
        </Button>
      </div>

      {isOpen && (
        <Popover
          position={getPopoverPosition()}
          onDismiss={handleDismiss}
          anchor="top-right"
          offset={{ x: 0, y: 6 }}
          className="flex max-h-[calc(100vh-24px)] w-120 flex-col p-4"
        >
          <h3 className="text-fg-default mb-3 shrink-0 text-sm font-semibold">
            Settings
          </h3>

          <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4 pb-2">
            <LLMSettings />

            <AcpSettings />

            <CanvasSettings />
          </div>

          <div className="mt-4 flex shrink-0 justify-end">
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={handleClose}
            >
              Close
            </Button>
          </div>
        </Popover>
      )}
    </>
  );
};
