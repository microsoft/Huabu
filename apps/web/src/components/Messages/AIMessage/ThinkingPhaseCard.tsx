/**
 * ThinkingPhaseCard — wraps a thinking segment together with the
 * tool runs that immediately follow it (see `groupByThinkingPhase`
 * for boundary rules).
 *
 * Visual intent: the thinking text is the phase TITLE — a one-line
 * "what I'm about to do" summary. The body holds the corresponding
 * tool calls (and, when expanded, the full thinking text above
 * them).
 *
 * Auto-collapse: while the phase is still the agent's latest activity
 * (no following phase / loose segment yet), the body stays expanded
 * so the user sees the tool calls live as they stream. Once the
 * agent moves on — a new thinking arrives, or a text/plan/permission
 * segment closes the phase — `closed` flips true and the
 * `AssistantDisclosure` collapses it into a single-line summary.
 * The user can still click to re-expand at any time.
 */

import { Loader2 } from 'lucide-react';

import { AssistantDisclosure } from '../AssistantDisclosure';

import type { ReactNode } from 'react';

interface ThinkingPhaseCardProps {
  text: string;
  /** True once a later phase or loose segment exists; drives auto-collapse. */
  closed: boolean;
  /**
   * True when the message itself is still streaming. Used to decide
   * whether to show the active spinner on an open (not-yet-closed)
   * phase.
   */
  isStreaming?: boolean;
  /** Rendered tool groups belonging to this phase. */
  children: ReactNode;
}

/** First non-empty line of the thinking text, used as the title. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export function ThinkingPhaseCard({
  text,
  closed,
  isStreaming,
  children,
}: ThinkingPhaseCardProps) {
  if (!text) {
    // Defensive: groupByThinkingPhase always opens a phase on a
    // thinking segment, but if that segment somehow has no text we
    // render the children flat rather than an empty title row.
    return <>{children}</>;
  }

  const preview = firstLine(text);
  // Spin only while the phase is still the agent's current activity
  // AND the turn is streaming. Once `closed`, fall back to the
  // standard idle dot.
  const showSpinner = isStreaming && !closed;
  const icon = showSpinner ? (
    <Loader2 size={10} className="text-fg-muted/60 animate-spin" />
  ) : (
    <span
      aria-hidden
      className="bg-fg-muted/50 inline-block h-1 w-1 rounded-full"
    />
  );

  // When the thinking text is just the preview line, skip the
  // duplicated text block in the body — the title already shows it
  // and the native tooltip exposes the full line on hover when
  // truncated. The disclosure stays expandable because the tool
  // groups still live in the body.
  //
  // Exception: a long single-line paragraph is visually truncated in
  // the one-line title, so its full text would otherwise only be
  // reachable via the hover tooltip. Surface it in the expandable body
  // too so the whole reasoning stays readable.
  const isMultiLine = text.trim() !== preview;
  const showBodyText = isMultiLine || preview.length > 80;

  return (
    <AssistantDisclosure
      icon={icon}
      title={showSpinner && !preview ? 'Thinking…' : preview}
      titleTooltip={showBodyText ? undefined : preview}
      defaultCollapsed={closed}
      collapseSignal={closed}
      bodyClassName="border-edge-default/40 ml-2 flex flex-col gap-1 border-l pl-3"
    >
      {showBodyText && (
        <div className="text-fg-muted/70 mb-1 px-1 text-xs wrap-break-word whitespace-pre-wrap italic">
          {text}
        </div>
      )}
      {children}
    </AssistantDisclosure>
  );
}
