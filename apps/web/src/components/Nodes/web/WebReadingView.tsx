// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';
import { getWebPage } from '@/api/web';
import { Button } from '@/components/Common/Button';
import { normalizeSafeLinkHref } from '@/utils/safeLink';

interface WebReadingViewProps {
  nodeId: string;
  canvasId: string;
  src: string;
  interactive: boolean;
  zoom: number;
}

/** Canvas-only display; authored interactive views keep their expanded bridge. */
export function WebReadingView({
  nodeId,
  canvasId,
  src,
  interactive,
  zoom,
}: WebReadingViewProps) {
  const { t } = useTranslation();
  const remoteHref = normalizeSafeLinkHref(src);
  const [page, setPage] = useState<{
    src: string;
    snapshot: boolean;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);

  useEffect(() => {
    // Remote pages must use the original URL, not the server's MHTML snapshot.
    if (remoteHref || !canvasId) return;
    let cancelled = false;
    void getWebPage({ canvasId, nodeId }).then(
      (result) => {
        if (cancelled) return;
        setPage({
          src:
            result.kind === 'url'
              ? (normalizeSafeLinkHref(result.src) ?? '')
              : resolveArtifactUrl(result.src, canvasId),
          snapshot: result.kind === 'html' && result.snapshot === true,
        });
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [canvasId, nodeId, remoteHref, retryAttempt]);

  const pageSrc = remoteHref ?? page?.src;
  const snapshot = !remoteHref && page?.snapshot;

  return (
    <div
      className="bg-surface flex h-full min-h-0 w-full flex-col"
      data-web-reading
      style={{
        width: `${zoom * 100}%`,
        height: `${zoom * 100}%`,
        transform: `scale(${1 / zoom})`,
        transformOrigin: 'top left',
      }}
    >
      <div className="relative min-h-0 flex-1">
        {failed ? (
          <div className="text-fg-subtle flex h-full flex-col items-center justify-center gap-2 text-sm">
            <span role="status">{t('node.failedLoadPage')}</span>
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              className="nodrag nopan"
              onClick={(event) => {
                event.stopPropagation();
                setFailed(false);
                setRetryAttempt((attempt) => attempt + 1);
              }}
            >
              {t('messages.retry')}
            </Button>
          </div>
        ) : pageSrc ? (
          <iframe
            key={`${pageSrc}:${retryAttempt}`}
            src={pageSrc}
            title={t('node.livePage')}
            // Like UrlPreview, never grant same-origin, including after redirects.
            sandbox={snapshot ? '' : 'allow-scripts allow-forms'}
            referrerPolicy="no-referrer"
            inert={!interactive}
            onErrorCapture={() => setFailed(true)}
            className={`bg-surface block h-full w-full border-0 ${interactive ? 'nodrag nopan nowheel' : 'pointer-events-none'}`}
            style={snapshot ? { colorScheme: 'light' } : undefined}
          />
        ) : (
          <div className="text-fg-subtle flex h-full items-center justify-center text-sm">
            {t(page ? 'node.noSource' : 'status.loading')}
          </div>
        )}
        {!interactive && !failed ? (
          <div
            className="absolute inset-0"
            aria-hidden="true"
            data-web-interaction-shield
          />
        ) : null}
      </div>
    </div>
  );
}
