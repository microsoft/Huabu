// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { Popover } from '@/components/Common/Popover';

import type { AcpSessionMetaSnapshot } from '@huabu/shared';

export interface SessionUsageProps {
  usage: AcpSessionMetaSnapshot['usage'];
  tokenUsage: AcpSessionMetaSnapshot['tokenUsage'];
  loading?: boolean;
  unavailable?: boolean;
}

function validTokens(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

export function SessionUsage({
  usage,
  tokenUsage,
  loading,
  unavailable,
}: SessionUsageProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const formatter = new Intl.NumberFormat(i18n.language);
  const absent = t('chat.sessionUsageUnavailable');
  const context =
    usage &&
    validTokens(usage.used) &&
    validTokens(usage.size) &&
    usage.size > 0
      ? `${formatter.format(usage.used)} / ${formatter.format(usage.size)} tokens`
      : absent;
  const cost =
    usage?.cost &&
    Number.isFinite(usage.cost.amount) &&
    usage.cost.amount >= 0 &&
    usage.cost.currency.trim()
      ? `${String(usage.cost.amount)} ${usage.cost.currency}`
      : absent;
  const tokens = (value: number | undefined) =>
    validTokens(value) ? `${formatter.format(value)} tokens` : absent;
  const received = (value: number | undefined) => {
    const date = value !== undefined && value > 0 ? new Date(value) : null;
    return date && Number.isFinite(date.getTime())
      ? t('chat.sessionUsageReceived', {
          time: date.toLocaleString(i18n.language),
        })
      : t('chat.sessionUsageTimeUnknown');
  };

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {t('chat.sessionUsage')}
      </Button>
      {open && (
        <Popover
          id={id}
          reference={trigger.current}
          placement="top-end"
          role="region"
          aria-label={t('chat.sessionUsage')}
          className="text-fg-default w-80 max-w-[calc(100vw-24px)] space-y-3 p-3 text-xs"
          onOpenAutoFocus={() => heading.current?.focus()}
          onDismiss={(reason) => {
            setOpen(false);
            if (reason === 'escape') trigger.current?.focus();
          }}
        >
          <h3 ref={heading} tabIndex={-1} className="font-medium">
            {t('chat.sessionUsage')}
          </h3>
          <p className="text-fg-muted">{t('chat.sessionUsageDisclaimer')}</p>
          {loading && <p role="status">{t('chat.sessionUsageLoading')}</p>}
          {unavailable && (
            <p role="status">{t('chat.sessionUsageRefreshFailed')}</p>
          )}
          <section aria-label={t('chat.sessionUsageContext')}>
            <dl className="space-y-1">
              <div className="flex justify-between gap-3">
                <dt>{t('chat.sessionUsageContext')}</dt>
                <dd className="text-right">{context}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>{t('chat.sessionUsageCost')}</dt>
                <dd className="text-right">{cost}</dd>
              </div>
            </dl>
            {usage && (
              <p className="text-fg-subtle mt-1">
                {received(usage.receivedAt)}
              </p>
            )}
          </section>
          <section aria-label={t('chat.sessionUsageTokens')}>
            <dl className="space-y-1">
              <div className="flex justify-between gap-3">
                <dt>{t('chat.sessionUsageInput')}</dt>
                <dd>{tokens(tokenUsage?.inputTokens)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>{t('chat.sessionUsageOutput')}</dt>
                <dd>{tokens(tokenUsage?.outputTokens)}</dd>
              </div>
            </dl>
            {tokenUsage && (
              <p className="text-fg-subtle mt-1">
                {received(tokenUsage.receivedAt)}
              </p>
            )}
          </section>
        </Popover>
      )}
    </>
  );
}
