// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * ThinkingCard — renders a `kind: 'thinking'` segment of an assistant
 * turn (reasoning / chain-of-thought text streamed via the
 * `thinking_delta` event), optionally as the head of a "phase" that
 * also owns the tool runs which immediately followed it.
 *
 * Two shapes, one component:
 *   - **Standalone** (no `children`): a bare thinking segment. The
 *     reasoning text IS the card; the body shows the full text when it
 *     adds anything over the one-line title.
 *   - **Phase** (`children` = tool groups, `closed` drives auto-collapse):
 *     the thinking text is the phase TITLE and the body holds the full
 *     text plus the tool calls that ran under it.
 *
 * Visual shell is delegated to `AssistantDisclosure`; this component
 * only chooses the leading marker (a tiny dot once idle, a spinner while
 * still the agent's current activity), the one-line preview title, and
 * whether to surface the full reasoning body.
 */

import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AssistantDisclosure } from '../AssistantDisclosure';

import type { ReactNode } from 'react';

interface ThinkingCardProps {
  text: string;
  /**
   * True while this thinking is still the agent's current activity — a
   * standalone segment that is the last one, or a not-yet-`closed` phase
   * on a streaming turn. Drives the spinner marker.
   */
  isStreaming?: boolean;
  /**
   * Tool runs that belong to this thinking phase, rendered in the body
   * under the reasoning text. Absent for a standalone thinking segment.
   */
  children?: ReactNode;
  /**
   * True once a later phase / segment has closed this one — drives
   * auto-collapse into a single-line summary. Omit for a standalone
   * thinking segment (which never auto-collapses).
   */
  closed?: boolean;
}

/** First non-empty line of the thinking text, used as a one-line preview. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export function ThinkingCard({
  text,
  isStreaming,
  children,
  closed,
}: ThinkingCardProps) {
  const { t } = useTranslation();
  if (!text) {
    // Defensive: a phase head with empty text — render its tool runs
    // flat rather than an empty title row.
    return <>{children}</>;
  }

  const preview = firstLine(text);
  // Spin only while this card is still the agent's current activity: a
  // streaming turn that hasn't closed this phase yet.
  const showSpinner = Boolean(isStreaming) && !closed;
  const icon = showSpinner ? (
    <Loader2 size={10} className="text-fg-muted/60 animate-spin" />
  ) : (
    <span
      aria-hidden
      className="bg-fg-muted/50 inline-block h-1 w-1 rounded-full"
    />
  );

  // Surface the full reasoning body whenever it adds anything over the
  // one-line title: multi-line text, a long single line (visually
  // truncated in the title), or while still streaming. Tool `children`
  // always render regardless, so a phase stays expandable even when its
  // title already shows the whole (short) thinking line.
  const isMultiLine = text.trim() !== preview;
  const showBodyText =
    isMultiLine || preview.length > 80 || Boolean(isStreaming);

  return (
    <AssistantDisclosure
      icon={icon}
      title={showSpinner && !preview ? t('messages.thinking') : preview}
      titleTooltip={showBodyText ? undefined : preview}
      defaultCollapsed={closed}
      collapseSignal={closed}
      bodyClassName="border-edge-default/40 ml-2 flex flex-col gap-1 border-l pl-3"
    >
      {showBodyText && (
        <div className="text-fg-muted/70 flex flex-col gap-1 px-1 italic">
          {text
            .trim()
            .split(/\n{2,}/)
            .map((para, i) => (
              <p key={i} className="wrap-break-word whitespace-pre-wrap">
                {para}
              </p>
            ))}
        </div>
      )}
      {children}
    </AssistantDisclosure>
  );
}
