import { Loader2 } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useIntentStore } from '../../store/intentStore';

/**
 * A floating popover that appears near the mouse cursor after the user
 * presses Ctrl+I. Shows a loading spinner while the backend is processing,
 * then displays a list of intent candidates.
 */
export const IntentPopover: React.FC = () => {
  const isOpen = useIntentStore((s) => s.isOpen);
  const isLoading = useIntentStore((s) => s.isLoading);
  const candidates = useIntentStore((s) => s.candidates);
  const position = useIntentStore((s) => s.position);
  const dismiss = useIntentStore((s) => s.dismiss);

  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as HTMLElement)
      ) {
        dismiss();
      }
    };

    // Close on Escape
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismiss();
      }
    };

    // Delay listener to avoid catching the triggering click
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', handleClick);
      window.addEventListener('keydown', handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, dismiss]);

  if (!isOpen || !position) return null;

  // Clamp position so the popover doesn't overflow the viewport
  const POPOVER_WIDTH = 320;
  const MARGIN = 12;
  const left = Math.min(position.x, window.innerWidth - POPOVER_WIDTH - MARGIN);
  const top = position.y + 8; // 8px below the cursor

  const popover = (
    <div
      ref={popoverRef}
      className="pointer-events-auto fixed z-[9999]"
      style={{ left, top, width: POPOVER_WIDTH }}
    >
      <div className="rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
        {isLoading ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-gray-500">
            <Loader2 size={16} className="animate-spin" />
            <span>Analysing context…</span>
          </div>
        ) : candidates.length === 0 ? (
          <div className="px-3 py-4 text-sm text-gray-400">
            No suggestions available.
          </div>
        ) : (
          <ul className="flex flex-col">
            {candidates.map((c, idx) => (
              <li key={idx}>
                <button
                  type="button"
                  className="flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-gray-100"
                  onClick={() => {
                    console.log('[Intent] User selected:', c.label);
                    dismiss();
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-800">
                      {c.label}
                    </span>
                    <span className="ml-2 text-xs text-gray-400">
                      {Math.round(c.confidence * 100)}%
                    </span>
                  </div>
                  {c.description && (
                    <span className="text-xs text-gray-500">
                      {c.description}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  return createPortal(popover, document.body);
};
