// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useId, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';

export function DesktopCloseOverlay({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    // A native modal stays interactive while the entire page, including portals, is inert.
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
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
        <div
          role="status"
          className="text-fg-muted flex items-center gap-2 text-sm"
        >
          <span aria-hidden="true">
            <Loading
              variant="spinner"
              layout="bare"
              size="md"
              indicatorClassName="text-fg-subtle"
            />
          </span>
          <span id={titleId}>{t('app.savingCanvas')}</span>
        </div>
        <Button
          variant="outline"
          onClick={(event) => {
            event.stopPropagation();
            onCancel();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {t('actions.cancel')}
        </Button>
      </div>
    </dialog>
  );
}
