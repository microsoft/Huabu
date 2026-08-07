// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Subscribe to the desktop auto-update lifecycle exposed by the Electron
 * main process over the `electronBridge.updater` bridge.
 *
 * Returns the latest {@link UpdateStatus} plus the three user-driven
 * actions. In a plain browser (no Electron bridge) the status stays
 * `idle` and the actions are inert no-ops, so callers can render
 * unconditionally and simply get nothing outside the desktop shell.
 *
 * The main process already checks on startup and on a periodic timer;
 * `check()` here is the manual "check for updates" affordance. Nothing
 * downloads or restarts without an explicit `download()` / `install()`
 * call (policy: prompt first, act on click).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getElectronBridge, type UpdateStatus } from './useElectron';
import { dismissToast, toast } from '../components/Common/Toast';

interface UseAppUpdate {
  status: UpdateStatus;
  check: () => void;
  download: () => void;
  install: () => void;
}

export function canCheckForUpdates(status: UpdateStatus): boolean {
  return (
    status.state === 'idle' ||
    status.state === 'not-available' ||
    status.state === 'error'
  );
}

export function useAppUpdate(): UseAppUpdate {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });

  useEffect(() => {
    const updater = getElectronBridge()?.updater;
    if (!updater) return;

    let cancelled = false;
    void updater
      .getState()
      .then((snapshot) => {
        if (!cancelled) setStatus(snapshot);
      })
      .catch(() => {
        // Keep the default state until the status stream emits.
      });
    const unsubscribe = updater.onStatus((next) => {
      setStatus(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // DEV-only visual harness. In an unpackaged `electron .` run the real
  // electron-updater events never fire (they require `app.isPackaged`),
  // so the header button would stay hidden and you could never eyeball
  // its states. This exposes `window.__setUpdateStatus(...)` so you can
  // drive each state live from the DevTools console, e.g.
  //   __setUpdateStatus({ state: 'available', version: '9.9.9' })
  //   __setUpdateStatus({ state: 'downloading', percent: 42, transferred: 0, total: 0, bytesPerSecond: 0 })
  //   __setUpdateStatus({ state: 'downloaded', version: '9.9.9' })
  //   __setUpdateStatus({ state: 'error', message: 'boom' })
  // Compiled out of production builds by the `import.meta.env.DEV` guard.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const holder = window as unknown as {
      __setUpdateStatus?: (next: UpdateStatus) => void;
    };
    holder.__setUpdateStatus = (next) => setStatus(next);
    return () => {
      delete holder.__setUpdateStatus;
    };
  }, []);

  const check = useCallback(() => {
    const updater = getElectronBridge()?.updater;
    if (!updater) return;

    const checkingToastId = toast(t('update.checking'), {
      tone: 'info',
      duration: 0,
      dismissible: false,
    });

    void updater
      .check()
      .then((result) => {
        dismissToast(checkingToastId);
        if (!result.ok) {
          toast(t('update.checkFailed', { message: result.error }), {
            tone: 'danger',
          });
          return;
        }

        switch (result.status.state) {
          case 'available':
            toast(
              t('update.foundVersion', { version: result.status.version }),
              { tone: 'info' },
            );
            break;
          case 'not-available':
            toast(
              t('update.currentVersion', { version: result.status.version }),
              { tone: 'success' },
            );
            break;
          case 'error':
            toast(t('update.checkFailed', { message: result.status.message }), {
              tone: 'danger',
            });
            break;
          default:
            toast(t('update.checkComplete'), { tone: 'success' });
            break;
        }
      })
      .catch((error: unknown) => {
        dismissToast(checkingToastId);
        toast(
          t('update.checkFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
          { tone: 'danger' },
        );
      });
  }, [t]);
  const download = useCallback(() => {
    void getElectronBridge()?.updater?.download();
  }, []);
  const install = useCallback(() => {
    void getElectronBridge()?.updater?.install();
  }, []);

  return { status, check, download, install };
}
