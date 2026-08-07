// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '../components/Common/Toast';

/**
 * Runs a desktop diagnostics action (see {@link ./useElectron}) and surfaces
 * the outcome as a toast: an optional success message on resolve, and the
 * localized `troubleshooting.actionFailed` message on reject.
 *
 * Shared by the in-app `AppMenu` dropdown and the native macOS menu bridge so
 * both entry points report diagnostics results identically.
 */
export function useRunDiagnostic(): (
  action: () => Promise<void>,
  successMessage?: string,
) => void {
  const { t } = useTranslation();

  return useCallback(
    (action: () => Promise<void>, successMessage?: string) => {
      void action()
        .then(() => {
          if (successMessage) toast(successMessage, { tone: 'success' });
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          toast(t('troubleshooting.actionFailed', { error: detail }), {
            tone: 'danger',
          });
        });
    },
    [t],
  );
}
