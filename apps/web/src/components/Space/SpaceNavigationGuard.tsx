// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router-dom';

import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';
import { Modal } from '@/components/Common/Modal';
import { toast } from '@/components/Common/Toast';
import {
  getElectronBridge,
  requireDesktopTabSuccess,
} from '@/hooks/useElectron';
import useCanvasStore, {
  discardPendingSaves,
  drainPendingSaves,
} from '@/store/canvasStore';
import { desktopNavigation } from '@/utils/desktopNavigation';

/** Keep mounted in the router root so the blocker survives route changes. */
export function SpaceNavigationGuard() {
  const { t } = useTranslation();
  const tabs = getElectronBridge()?.tabs;
  const stayRef = useRef<HTMLButtonElement>(null);
  const savingDialog = useRef<HTMLDialogElement>(null);
  const discarding = useRef(false);
  const [isDraining, setIsDraining] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [failedCanvasId, setFailedCanvasId] = useState<string | null>(null);
  const [discardError, setDiscardError] = useState(false);
  useLayoutEffect(() => {
    if (!isDraining) return;
    const dialog = savingDialog.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, [isDraining]);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      desktopNavigation(tabs?.context, nextLocation) !== null ||
      (currentLocation.pathname.startsWith('/canvas/') &&
        currentLocation.pathname !== nextLocation.pathname),
  );
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const target = desktopNavigation(tabs?.context, blocker.location);
    if (tabs && target) {
      void tabs
        .open(target)
        .then(requireDesktopTabSuccess)
        .catch((error: unknown) => {
          console.error('[desktop-tabs] Could not open Space:', error);
          toast(error instanceof Error ? error.message : String(error), {
            tone: 'danger',
          });
        })
        .finally(() => blocker.reset?.());
      return;
    }
    let cancelled = false;
    const canvasId = useCanvasStore.getState().canvasId;
    setIsDraining(false);
    setFailedCanvasId(null);
    setDiscardError(false);
    const timer = window.setTimeout(() => {
      if (!cancelled) setIsDraining(true);
    }, 150);
    void (async () => {
      let saved = false;
      try {
        await drainPendingSaves(canvasId);
        saved = true;
      } catch (error) {
        console.error('Space navigation blocked by unsaved changes:', error);
        if (!cancelled) setFailedCanvasId(canvasId);
      } finally {
        window.clearTimeout(timer);
        if (!cancelled) setIsDraining(false);
      }
      if (saved && !cancelled) blocker.proceed();
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [blocker, tabs]);

  const stay = () => {
    if (discarding.current) return;
    setFailedCanvasId(null);
    if (blocker.state === 'blocked') blocker.reset();
  };
  const discard = async () => {
    if (
      discarding.current ||
      failedCanvasId === null ||
      blocker.state !== 'blocked'
    )
      return;
    discarding.current = true;
    setIsDiscarding(true);
    setDiscardError(false);
    try {
      await discardPendingSaves(failedCanvasId);
      setFailedCanvasId(null);
      blocker.proceed();
    } catch (error) {
      console.error('Failed to discard Space changes:', error);
      setDiscardError(true);
    } finally {
      discarding.current = false;
      setIsDiscarding(false);
    }
  };

  return (
    <>
      {isDraining && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-redundant-roles -- Capture-phase shortcut guards require an explicit dialog role; bubbling is also isolated.
        <dialog
          ref={savingDialog}
          role="dialog"
          aria-label={t('app.savingCanvas')}
          className="bg-surface fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 p-0"
          onCancel={(event) => event.preventDefault()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Loading
            variant="spinner"
            layout="overlay"
            size="md"
            message={t('app.savingCanvas')}
            indicatorClassName="text-fg-subtle"
          />
        </dialog>
      )}
      <Modal
        isOpen={failedCanvasId !== null && blocker.state === 'blocked'}
        title={t('app.unsavedChangesTitle')}
        description={t('app.unsavedChangesDescription')}
        initialFocusRef={stayRef}
        onClose={stay}
        closeOnEscape={!isDiscarding}
        closeOnBackdropClick={!isDiscarding}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              ref={stayRef}
              variant="outline"
              disabled={isDiscarding}
              onClick={stay}
            >
              {t('app.stayInSpace')}
            </Button>
            <Button
              tone="danger"
              disabled={isDiscarding}
              onClick={() => void discard()}
            >
              {isDiscarding && <Loading layout="inline" size="sm" />}
              {t('app.discardAndLeave')}
            </Button>
          </div>
        }
      >
        {discardError && (
          <p role="alert" className="text-danger-fg mt-3 text-sm">
            {t('app.discardFailed')}
          </p>
        )}
      </Modal>
    </>
  );
}
