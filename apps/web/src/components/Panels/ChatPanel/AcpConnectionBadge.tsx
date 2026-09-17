// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `AcpConnectionBadge` — transient/problem status for the selected
 * external execution machine.
 *
 * Cached capability metadata is not proof of a live ACP session, so the
 * healthy state renders no badge. The parent supplies only positive
 * connecting or failure evidence from machine discovery and cache reads.
 *
 * States (mutually exclusive; derived upstream from
 * {@link useAcpSessionMeta}'s `{loading, error, meta.updatedAt}`):
 *
 *   • `connecting` — the GET-only capability cache read is in flight.
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

export type AcpConnectionStatus = 'connecting' | 'failed';

interface AcpConnectionBadgeProps {
  status: AcpConnectionStatus;
  /** Display name of the bound external agent — shown in tooltips. */
  alias: string;
  /** Underlying discovery or cache error for the failed-state tooltip. */
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
      <Tooltip
        content={t('chat.connecting')}
        placement="bottom"
        wrapperClassName="inline-flex shrink-0"
      >
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
      wrapperClassName="inline-flex shrink-0"
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
