/**
 * `AcpConnectionBadge` — three-state pill summarising the live
 * transport health of the thread's bound external agent.
 *
 * States (mutually exclusive; derived upstream from
 * {@link useAcpSessionMeta}'s `{loading, error, meta.updatedAt}`):
 *
 *   • `connecting` — first ensure-session in flight. Blue breathing
 *     dot, tooltip. No text on the badge
 *     itself; we don't want to draw attention while the warm-up
 *     usually completes within a few hundred ms. Subsequent
 *     transient loadings (set-mode / set-model) do NOT regress to
 *     this state — see ChatPanel's `acpConnectionStatus` derivation.
 *
 *   • `connected` — at least one successful meta payload has been
 *     received. Green solid dot, tooltip. No
 *     visible text either — once everything is working the badge
 *     should be near-invisible chrome.
 *
 *   • `failed` — last ensure rejected and we never got a meta
 *     snapshot. Red dot + uppercase "FAILED" text so the failure
 *     state is unmissable. Tooltip carries the actual error message
 *     when one is available, falling back to a generic explanation
 *     pointing at Settings → External Agents.
 *
 * The component never renders for internal bindings or before the
 * upstream status enum has been derived — the parent gates on
 * `agentBinding.kind === 'external'` first.
 */

import { Tooltip } from '@/components/Common/Tooltip';

import type { FC } from 'react';

export type AcpConnectionStatus = 'connecting' | 'connected' | 'failed';

interface AcpConnectionBadgeProps {
  status: AcpConnectionStatus;
  /** Display name of the bound external agent — shown in tooltips. */
  alias: string;
  /**
   * Last error from the ensure-session pipeline. Used as the tooltip
   * body for the `failed` state. Ignored for other states.
   */
  errorMessage?: string | null;
}

export const AcpConnectionBadge: FC<AcpConnectionBadgeProps> = ({
  status,
  alias,
  errorMessage,
}) => {
  if (status === 'connecting') {
    return (
      <Tooltip content={`Connecting…`}>
        <span
          className="inline-flex shrink-0 items-center gap-1 px-0.5 py-0.5"
          aria-label={`Connecting`}
        >
          <span
            aria-hidden
            className="bg-info h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
          />
        </span>
      </Tooltip>
    );
  }

  if (status === 'connected') {
    return (
      <Tooltip content={`Connected`}>
        <span
          className="inline-flex shrink-0 items-center gap-1 px-0.5 py-0.5"
          aria-label={`Connected`}
        >
          <span
            aria-hidden
            className="bg-success h-1.5 w-1.5 shrink-0 rounded-full opacity-50"
          />
        </span>
      </Tooltip>
    );
  }

  // failed
  const tooltipText =
    errorMessage && errorMessage.length > 0
      ? errorMessage
      : `Could not connect to ${alias}. Check Settings → External Agents.`;
  return (
    <Tooltip content={tooltipText}>
      <span
        className="text-danger inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
        aria-label={tooltipText}
      >
        <span
          aria-hidden
          className="bg-danger h-1.5 w-1.5 shrink-0 rounded-full"
        />
        Failed
      </span>
    </Tooltip>
  );
};
