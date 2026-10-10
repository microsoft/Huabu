// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `AcpConnectionBadge` describes capability-cache loading, not live
 * transport health. Preview tabs reuse its dot and description.
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

import { cn } from '@/components/Common/cn';
import { Tooltip } from '@/components/Common/Tooltip';

import type { FC } from 'react';

export type AcpConnectionStatus = 'connecting' | 'connected' | 'failed';

export interface AcpConnectionInfo {
  status: AcpConnectionStatus;
  /** Display name of the bound external agent. */
  alias: string;
  /**
   * Last capability-cache read error.
   */
  errorMessage?: string | null;
}

export function useAcpConnectionDescription(
  connection?: AcpConnectionInfo | null,
) {
  const { t } = useTranslation();
  if (!connection) return null;
  return t(`chat.capabilityStatus.${connection.status}`);
}

export function AcpConnectionDot({
  status,
  className,
}: {
  status: AcpConnectionStatus;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-acp-connection-status={status}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        status === 'connected' && 'bg-success/50',
        status === 'connecting' &&
          'bg-info animate-pulse motion-reduce:animate-none',
        status === 'failed' && 'bg-danger',
        className,
      )}
    />
  );
}

export const AcpConnectionBadge: FC<AcpConnectionInfo> = (connection) => {
  const { t } = useTranslation();
  const tooltipText = useAcpConnectionDescription(connection);
  return (
    <Tooltip
      content={tooltipText}
      placement="bottom"
      wrapperClassName="inline-flex shrink-0"
      contentClassName="whitespace-pre-line"
    >
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 px-0.5 py-0.5',
          connection.status === 'failed' &&
            'text-danger text-[10px] font-medium',
        )}
        aria-label={tooltipText ?? undefined}
      >
        <AcpConnectionDot status={connection.status} />
        {connection.status === 'failed' && t('chat.connectionLabel.failed')}
      </span>
    </Tooltip>
  );
};
