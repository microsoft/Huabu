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
 *   • `connecting` — the GET-only capability cache read is in flight.
 *
 *   • `connected` — default. Cache hit, post-success steady state,
 *     OR a transient refresh error while we still have a usable
 *     cached snapshot. Green solid dot, no text — once everything is
 *     working the badge should be near-invisible chrome.
 *
 *   • `failed` — the cache read failed and there is no snapshot to show.
 *
 * The component never renders for internal bindings or before the
 * upstream status enum has been derived — the parent gates on
 * `agentBinding.kind === 'external'` first.
 */

import { useTranslation } from 'react-i18next';

import { Tooltip } from '@/components/Common/Tooltip';

import type { FC } from 'react';

export type AcpConnectionStatus = 'connecting' | 'connected' | 'failed';

interface AcpConnectionBadgeProps {
  status: AcpConnectionStatus;
  /** Display name of the bound external agent — shown in tooltips. */
  alias: string;
  /**
   * Last capability-cache read error. Used by the failed-state tooltip.
   */
  errorMessage?: string | null;
}

export const AcpConnectionBadge: FC<AcpConnectionBadgeProps> = ({
  status,
  alias,
  errorMessage,
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
  const headline = t('chat.connectionHeadline.fallback', { alias });
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
        {t('chat.connectionLabel.failed')}
      </span>
    </Tooltip>
  );
};
