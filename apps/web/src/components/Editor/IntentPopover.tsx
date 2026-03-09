import { Loader2, Play } from 'lucide-react';
import React from 'react';

import { useIntentStore } from '../../store/intentStore';
import { Popover } from '../Common/Popover';

/**
 * A floating popover that appears near the mouse cursor after the user
 * presses Ctrl+I. Shows a loading spinner while the backend is processing,
 * then displays a list of intent candidates the user can execute.
 */
export const IntentPopover: React.FC = () => {
  const isOpen = useIntentStore((s) => s.isOpen);
  const isLoading = useIntentStore((s) => s.isLoading);
  const candidates = useIntentStore((s) => s.candidates);
  const position = useIntentStore((s) => s.position);
  const dismiss = useIntentStore((s) => s.dismiss);
  const executeIntent = useIntentStore((s) => s.executeIntent);

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
                onClick={() => executeIntent(idx)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Play size={10} className="text-theme-500 flex-shrink-0" />
                    <span className="text-foreground text-sm font-medium">
                      {c.label}
                    </span>
                  </div>
                  <span className="text-muted-foreground ml-2 text-xs">
                    {Math.round(c.confidence * 100)}%
                  </span>
                </div>
                {c.description && (
                  <span className="text-muted-foreground pl-4 text-xs">
                    {c.description}
                  </span>
                )}
                {c.actions.length > 0 && (
                  <span className="text-muted-foreground/50 pl-4 text-[10px]">
                    {c.actions.length} step{c.actions.length > 1 ? 's' : ''}:{' '}
                    {c.actions.map((a) => a.op).join(' → ')}
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
