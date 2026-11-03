// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useId, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Loading } from '@/components/Common/Loading';

export function DesktopCloseOverlay() {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    // Keep progress above the inert page without changing its layout.
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      data-desktop-close-controls
      data-canvas-panel
      aria-labelledby={titleId}
      className="bg-surface text-fg-default fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 p-6"
      onCancel={(event) => event.preventDefault()}
    >
      <div className="flex h-full items-center justify-center">
        <div
          role="status"
          className="text-fg-muted flex items-center gap-2 text-sm"
        >
          <span aria-hidden="true">
            <Loading variant="brand" layout="bare" size="md" />
          </span>
          <span id={titleId}>{t('app.savingCanvas')}</span>
        </div>
      </div>
    </dialog>
  );
}
