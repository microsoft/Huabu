// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { useAppUpdate } from '../../hooks/useAppUpdate';
import { Button } from '../Common/Button';

/**
 * Header affordance that surfaces the desktop auto-update lifecycle.
 *
 * Renders nothing until there is something for the user to act on, so it
 * stays invisible in the common "already up to date" case:
 *
 *   available   → "Update available" — click to start the download
 *   downloading → progress percentage (non-interactive)
 *   downloaded  → "Restart to update" — click to quit + install
 *   error       → warning — click to re-check
 *
 * Nothing downloads or restarts on its own: each transition past
 * `available` is driven by an explicit click (see `useAppUpdate`). Lives
 * only inside the Electron shell — its parent (`WindowChrome`) already
 * returns `null` in the browser.
 */
export function UpdateButton() {
  const { t } = useTranslation();
  const { status, download, install, check } = useAppUpdate();

  switch (status.state) {
    case 'available':
      return (
        <Button
          variant="solid"
          tone="info"
          size="sm"
          shape="pill"
          tooltipPlacement="bottom"
          title={t('update.availableVersion', { version: status.version })}
          onClick={download}
        >
          {t('update.available')}
        </Button>
      );

    case 'downloading':
      return (
        <Button
          variant="solid"
          tone="info"
          size="sm"
          shape="pill"
          disabled
          title={t('update.downloading', {
            percent: Math.round(status.percent),
          })}
          tooltipPlacement="bottom"
        >
          {`${Math.round(status.percent)}%`}
        </Button>
      );

    case 'downloaded':
      return (
        <Button
          variant="solid"
          tone="success"
          size="sm"
          shape="pill"
          tooltipPlacement="bottom"
          title={t('update.restartReady', { version: status.version })}
          onClick={install}
        >
          {t('update.restart')}
        </Button>
      );

    case 'error':
      return (
        <Button
          variant="solid"
          tone="danger"
          size="sm"
          shape="pill"
          tooltipPlacement="bottom"
          title={t('update.errorRetry', { message: status.message })}
          onClick={check}
        >
          {t('update.error')}
        </Button>
      );

    default:
      // idle / checking / not-available → nothing to show.
      return null;
  }
}
