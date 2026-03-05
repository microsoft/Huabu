import { Loader2 } from 'lucide-react';
import React from 'react';

import { useIntentStore } from '../../store/intentStore';
import { Popover } from '../Common/Popover';

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

  if (!isOpen || !position) return null;

  return (
    <Popover
      position={position}
      onDismiss={dismiss}
      dismissOnEscape
      offset={{ x: 0, y: 8 }}
      className="w-80 p-2"
    >
      {isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 px-3 py-4 text-sm">
          <Loader2 size={16} className="animate-spin" />
          <span>Analyzing context…</span>
        </div>
      ) : candidates.length === 0 ? (
        <div className="text-muted-foreground px-3 py-4 text-sm">
          No suggestions available.
        </div>
      ) : (
        <ul className="flex flex-col">
          {candidates.map((c, idx) => (
            <li key={idx}>
              <button
                type="button"
                className="hover:bg-muted flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors"
                onClick={() => {
                  console.log('[Intent] User selected:', c.label);
                  dismiss();
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-foreground text-sm font-medium">
                    {c.label}
                  </span>
                  <span className="text-muted-foreground ml-2 text-xs">
                    {Math.round(c.confidence * 100)}%
                  </span>
                </div>
                {c.description && (
                  <span className="text-muted-foreground text-xs">
                    {c.description}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
};
