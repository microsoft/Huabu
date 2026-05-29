/**
 * ThinkingCard — renders a `kind: 'thinking'` segment of an assistant
 * turn (reasoning / chain-of-thought text streamed via the
 * `thinking_delta` event).
 *
 * Visual shell is delegated to `AssistantDisclosure`; this component
 * only chooses the leading marker (a tiny dot once streaming is done,
 * a spinner while still emitting) and the one-line preview text.
 */

import { Loader2 } from 'lucide-react';

import { AssistantDisclosure } from '../AssistantDisclosure';

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
  if (!text) return null;

  const preview = firstLine(text);
  const icon = isStreaming ? (
    <Loader2 size={10} className="text-fg-muted/60 animate-spin" />
  ) : (
    <span
      aria-hidden
      className="bg-fg-muted/50 inline-block h-1 w-1 rounded-full"
    />
  );

  // Skip the body when it would only repeat the preview line — the
  // disclosure then renders as a non-expandable row. While streaming
  // we keep it expandable since more lines may still arrive. When the
  // preview line is too long to fit, the native `title` tooltip
  // surfaces the full text on hover so nothing is lost.
  const isMultiLine = text.trim() !== preview;
  const showBody = Boolean(isStreaming) || isMultiLine;

  return (
    <AssistantDisclosure
      icon={icon}
      title={isStreaming && !preview ? 'Thinking…' : preview}
      titleTooltip={showBody ? undefined : preview}
      bodyClassName="ml-2"
    >
      {showBody ? (
        <div className="wrap-break-word whitespace-pre-wrap italic">{text}</div>
      ) : undefined}
    </AssistantDisclosure>
  );
}
