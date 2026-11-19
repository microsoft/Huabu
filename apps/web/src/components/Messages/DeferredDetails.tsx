// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { useHistoryToolDetails } from '@/hooks/useHistoryToolDetails';

import { Button } from '../Common/Button';

/** Mounting or expanding this placeholder never starts a request. */
export function DeferredDetails({ turnRef }: { turnRef: string }) {
  const { t } = useTranslation();
  const { status, load } = useHistoryToolDetails(turnRef);
  return (
    <div
      className="text-fg-muted px-2 py-1 text-xs"
      aria-busy={status === 'loading'}
    >
      {status === 'error' && (
        <p role="alert" className="text-danger">
          {t('messages.detailsLoadFailed')}
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={status === 'loading'}
        onClick={() => void load()}
      >
        {t(
          status === 'loading'
            ? 'messages.detailsLoading'
            : status === 'error'
              ? 'messages.retry'
              : 'messages.seeMore',
        )}
      </Button>
    </div>
  );
}
