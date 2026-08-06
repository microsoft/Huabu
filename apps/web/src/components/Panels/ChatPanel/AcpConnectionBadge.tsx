// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `AcpConnectionBadge` — three-state pill summarising the live
 * transport health of the thread's bound external agent.
 *
 * **Optimistic-green design**: opening a thread no longer triggers a
 * real ensure-session — the chat panel hydrates selectors from a
 * cached meta snapshot first (see `useAcpSessionMeta`). The badge
 * therefore defaults to `connected` and only deviates when there is
 * positive evidence of trouble.
 *
 * States (mutually exclusive; derived upstream from
 * {@link useAcpSessionMeta}'s `{loading, error, meta.updatedAt}`):
 *
 *   • `connecting` — a real `ensureAcpSession` is currently in flight
 *     (refresh / set-mode / set-model / set-config-option). Blue
 *     breathing dot, no text — the warm-up usually completes within
 *     a few hundred ms.
 *
 *   • `connected` — default. Cache hit, post-success steady state,
 *     OR a transient refresh error while we still have a usable
 *     cached snapshot. Green solid dot, no text — once everything is
 *     working the badge should be near-invisible chrome.
 *
 *   • `failed` — the last ensure rejected AND there's no cached
 *     snapshot to fall back on. Red dot + uppercase "FAILED" text so
 *     the failure is unmissable. Tooltip carries the actual error
 *     message when available, falling back to a generic explanation
 *     pointing at Settings → External Agents.
 *
 * The component never renders for internal bindings or before the
 * upstream status enum has been derived — the parent gates on
 * `agentBinding.kind === 'external'` first.
 */

import { useTranslation } from 'react-i18next';

import { Tooltip } from '@/components/Common/Tooltip';

import type { AcpEnsureErrorCode } from '@huabu/shared';
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
  /**
   * Categorical error code from the server (when available). Drives
   * a remediation-specific tooltip headline so the user knows the
   * concrete next step (e.g. "Restart worker" vs "Re-create profile")
   * instead of just seeing a raw error message.
   */
  errorCode?: AcpEnsureErrorCode | null;
}

export const AcpConnectionBadge: FC<AcpConnectionBadgeProps> = ({
  status,
  alias,
  errorMessage,
  errorCode,
}) => {
  const { t } = useTranslation();
  if (status === 'connecting') {
    return (
      <Tooltip content={t('chat.connecting')} placement="bottom">
        <span
          className="inline-flex shrink-0 items-center gap-1 px-0.5 py-0.5"
          aria-label={t('chat.connecting')}
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
      <Tooltip content={t('chat.connected')} placement="bottom">
        <span
          className="inline-flex shrink-0 items-center gap-1 px-0.5 py-0.5"
          aria-label={t('chat.connected')}
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
  // Categorical headline drives the user to the right remediation
  // without needing to read the raw error. The detail message is
  // appended on a second line so power users can still see the
  // underlying server text.
  const headline = headlineForCode(errorCode, alias, t);
  const tooltipText =
    errorMessage && errorMessage.length > 0
      ? `${headline}\n\n${errorMessage}`
      : headline;
  return (
    <Tooltip
      content={tooltipText}
      placement="bottom"
      contentClassName="whitespace-pre-line"
    >
      <span
        className="text-danger inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
        aria-label={tooltipText}
      >
        <span
          aria-hidden
          className="bg-danger h-1.5 w-1.5 shrink-0 rounded-full"
        />
        {labelForCode(errorCode, t)}
      </span>
    </Tooltip>
  );
};

/**
 * Short uppercase label rendered next to the red dot. Kept terse
 * (≤7 chars) so it doesn't blow out the toolbar; the full sentence
 * lives in the tooltip.
 */
function labelForCode(
  code: AcpEnsureErrorCode | null | undefined,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  switch (code) {
    case 'worker_not_ready':
    case 'placement_unavailable':
      return t('chat.connectionLabel.worker');
    case 'profile_missing':
      return t('chat.connectionLabel.profile');
    case 'spawn_failed':
    case 'session_resume_unavailable':
      return t('chat.connectionLabel.spawn');
    case 'connect_timeout':
      return t('chat.connectionLabel.timeout');
    case 'bridge_not_mounted':
      return t('chat.connectionLabel.starting');
    default:
      return t('chat.connectionLabel.failed');
  }
}

/**
 * One-sentence remediation headline shown at the top of the tooltip.
 * Each code points at the concrete next step — the raw server
 * message is appended below for diagnostics.
 */
function headlineForCode(
  code: AcpEnsureErrorCode | null | undefined,
  alias: string,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  switch (code) {
    case 'worker_not_ready':
    case 'placement_unavailable':
      return t('chat.connectionHeadline.workerNotReady');
    case 'profile_missing':
      return t('chat.connectionHeadline.profileMissing', { alias });
    case 'spawn_failed':
    case 'session_resume_unavailable':
      return t('chat.connectionHeadline.spawnFailed', { alias });
    case 'connect_timeout':
      return t('chat.connectionHeadline.connectTimeout', { alias });
    case 'bridge_not_mounted':
      return t('chat.connectionHeadline.bridgeNotMounted');
    case 'internal':
      return t('chat.connectionHeadline.internal', { alias });
    default:
      return t('chat.connectionHeadline.fallback', { alias });
  }
}
