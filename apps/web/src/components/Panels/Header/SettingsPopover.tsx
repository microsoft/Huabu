import { Settings } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';

import { LLMSettings } from './LLMSettings';
import { useLLMStore } from '../../../store/llmStore';
import { Button } from '../../Common/Button';
import { Popover } from '../../Common/Popover';

/**
 * Settings popover. Currently only exposes LLM provider/model configuration.
 * Workspace switching lives on the home page (`/` and `/setup`).
 */
export const SettingsPopover: React.FC = () => {
  const llmInit = useLLMStore((s) => s.init);

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
      if (next) void llmInit();
      return next;
    });
  }, [llmInit]);

  const getPopoverPosition = () => {
    if (!triggerRef.current) return { x: 0, y: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    return { x: rect.right, y: rect.bottom };
  };

  return (
    <>
      <div ref={triggerRef}>
        <Button
          variant="outline"
          shape="pill"
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

          <LLMSettings />

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
