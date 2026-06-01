import { Settings, Sparkles } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';

import { AcpSettings } from './AcpSettings';
import { LLMSettings } from './LLMSettings';
import { useAcpConfigStore } from '../../../store/acpConfigStore';
import useCanvasStore from '../../../store/canvasStore';
import { useLLMStore } from '../../../store/llmStore';
import { Button } from '../../Common/Button';
import { Popover } from '../../Common/Popover';

interface SettingsPopoverProps {
  /**
   * Visual style of the trigger button. Defaults to `ghost` to match the
   * in-chat header. Pass `outline` / `pill` to render as a circular outline
   * button (matches the floating top-right canvas controls).
   */
  variant?: 'ghost' | 'outline';
  shape?: 'default' | 'pill';
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Settings popover. Currently only exposes LLM provider/model configuration.
 * Workspace switching lives on the home page (`/` and `/setup`).
 */
export const SettingsPopover: React.FC<SettingsPopoverProps> = ({
  variant = 'ghost',
  shape = 'default',
  size = 'md',
}) => {
  const llmInit = useLLMStore((s) => s.init);
  const acpInit = useAcpConfigStore((s) => s.init);
  const autoLayoutEnabled = useCanvasStore((s) => s.autoLayoutEnabled);
  const toggleAutoLayout = useCanvasStore((s) => s.toggleAutoLayout);

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
          className="w-80 p-4"
        >
          <h3 className="text-fg-default mb-3 text-sm font-semibold">
            Settings
          </h3>

          <div className="border-edge-default mb-3 border-b pb-3">
            <label className="text-fg-muted mb-1.5 block text-xs font-medium">
              Canvas
            </label>
            <div className="border-edge-default bg-bg-default flex items-center justify-between rounded-md border px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <Sparkles size={14} className="text-fg-muted shrink-0" />
                <div className="min-w-0">
                  <p className="text-fg-default text-xs font-medium">
                    Auto Layout
                  </p>
                  <p className="text-fg-subtle text-[11px]">
                    {autoLayoutEnabled ? 'Enabled' : 'Disabled'}
                  </p>
                </div>
              </div>
              <Button
                variant={autoLayoutEnabled ? 'solid' : 'outline'}
                tone={autoLayoutEnabled ? 'info' : 'neutral'}
                size="sm"
                onClick={() => toggleAutoLayout()}
                title={
                  autoLayoutEnabled
                    ? 'Disable Auto Layout'
                    : 'Enable Auto Layout'
                }
              >
                {autoLayoutEnabled ? 'Disable' : 'Enable'}
              </Button>
            </div>
          </div>

          <LLMSettings />

          <AcpSettings />

          <div className="flex justify-end">
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
