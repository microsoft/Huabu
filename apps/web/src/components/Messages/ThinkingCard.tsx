/**
 * ThinkingCard — renders a `kind: 'thinking'` segment of an assistant
 * turn (reasoning / chain-of-thought text streamed via the
 * `thinking_delta` event).
 *
 * Collapsed header shows a single-line preview (first non-empty line
 * of the thinking text, truncated with ellipsis). A small dot stands
 * in for the leading marker once streaming is done; while streaming
 * we show a spinner instead so the user can see the model is still
 * emitting reasoning. The body expands on click.
 */

import { Loader2 } from 'lucide-react';
import { useId, useState } from 'react';

interface ThinkingCardProps {
  text: string;
  isStreaming?: boolean;
}

/** First non-empty line of the thinking text, used as a one-line preview. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export function ThinkingCard({ text, isStreaming }: ThinkingCardProps) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const bodyId = useId();

  if (!text) return null;

  const preview = firstLine(text);

  return (
    <div className="flex justify-start">
      <div className="w-full min-w-0">
        <button
          type="button"
          onClick={() => setIsCollapsed((prev) => !prev)}
          aria-expanded={!isCollapsed}
          aria-controls={bodyId}
          className="text-fg-muted hover:bg-hover flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-xs transition-colors"
        >
          {isStreaming ? (
            <Loader2
              size={10}
              className="text-fg-subtle shrink-0 animate-spin"
            />
          ) : (
            <span
              aria-hidden
              className="bg-fg-subtle inline-block h-1 w-1 shrink-0 rounded-full"
            />
          )}
          <span className="min-w-0 flex-1 truncate">
            {isStreaming && !preview ? 'Thinking…' : preview}
          </span>
        </button>

        {!isCollapsed && (
          <div id={bodyId} className="text-fg-muted mt-1 ml-2 text-xs">
            <div className="wrap-break-word whitespace-pre-wrap italic">
              {text}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
