// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { ToastCard } from '@/components/Common/Toast';

interface PanelAlertProps {
  /** Localized sentence shown to the user. */
  message: string;
  /** Raw technical cause, available on hover rather than in the sentence. */
  detail?: string | null;
  onRetry: () => void;
}

/** A failure row above the message list, with its own retry. */
export function PanelAlert({ message, detail, onRetry }: PanelAlertProps) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-center px-3">
      <ToastCard
        role="alert"
        tone="danger"
        message={message}
        title={detail ?? undefined}
        action={{ label: t('messages.retry'), onClick: onRetry }}
      />
    </div>
  );
}
