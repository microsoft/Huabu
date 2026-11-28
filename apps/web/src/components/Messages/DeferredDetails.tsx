// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { useHistoryToolDetails } from '@/hooks/useHistoryToolDetails';

import { Button } from '../Common/Button';

/** Loads on mount: callers render it only inside a row the user expanded. */
export function DeferredDetails({ turnRef }: { turnRef: string }) {
  const { t } = useTranslation();
  const { status, retry } = useHistoryToolDetails(turnRef);
  return (
    <div
      className="text-fg-muted px-2 py-1 text-xs"
      aria-busy={status === 'loading'}
    >
      {status === 'loading' ? (
        <p>{t('messages.detailsLoading')}</p>
      ) : (
        <>
          <p role="alert" className="text-danger">
            {t('messages.detailsLoadFailed')}
          </p>
          <Button variant="ghost" size="sm" onClick={retry}>
            {t('messages.retry')}
          </Button>
        </>
      )}
    </div>
  );
}
