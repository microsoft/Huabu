// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';
import { getWebPage, getWebReader } from '@/api/web';
import { Button } from '@/components/Common/Button';
import { normalizeSafeLinkHref } from '@/utils/safeLink';

import { ReaderFrame } from './ReaderFrame';
import { useInteractiveViewBridge } from './useInteractiveViewBridge';

interface WebReadingViewProps {
  nodeId: string;
  canvasId: string;
  src: string;
  interactive: boolean;
  isInteractiveView: boolean;
  zoom: number;
  /** Whether the Server has extracted this page's text yet. */
  hasContent: boolean;
  /** Shown for another site's page that has no reader view. */
  fallback: ReactNode;
}

/**
 * A web node at reading size on the Canvas.
 *
 * Another site's page is shown as its reader view — the text the Server
 * extracted — and never loaded here: the Canvas holds many nodes at once, and
 * none of them should run a third party's page inside the application. The
 * live page is one click away in the Preview panel.
 *
 * A page stored in the Space (an Agent's, or an upload) is shown live, and
 * reuses the expanded preview's capability bridge.
 */
export function WebReadingView({
  nodeId,
  canvasId,
  src,
  interactive,
  isInteractiveView,
  zoom,
  hasContent,
  fallback,
}: WebReadingViewProps) {
  const { t } = useTranslation();
  const remoteHref = normalizeSafeLinkHref(src);
  const [page, setPage] = useState<{
    src: string;
    snapshot: boolean;
    kind: 'url' | 'html';
  } | null>(null);
  const [failure, setFailure] = useState<'page' | 'interactive' | null>(null);
  const failed = failure !== null;
  const [retryAttempt, setRetryAttempt] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onBootstrapError = useCallback(() => setFailure('interactive'), []);
  const bridge = useInteractiveViewBridge({
    enabled:
      isInteractiveView &&
      !remoteHref &&
      page?.kind === 'html' &&
      !page.snapshot &&
      !failed,
    canvasId,
    nodeId,
    iframeRef,
    onBootstrapError,
  });

  // `undefined` while it is fetched; `null` when the page has none.
  const [reader, setReader] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!remoteHref || !canvasId) return;
    if (!hasContent) {
      setReader(null);
      return;
    }
    let cancelled = false;
    setReader(undefined);
    void getWebReader({ canvasId, nodeId }).then(
      (result) => {
        if (!cancelled) setReader(result.html || null);
      },
      () => {
        if (!cancelled) setReader(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [canvasId, nodeId, remoteHref, hasContent]);

  useEffect(() => {
    // A remote page is never resolved to the server's MHTML snapshot.
    if (remoteHref || !canvasId) return;
    let cancelled = false;
    void getWebPage({ canvasId, nodeId }).then(
      (result) => {
        if (cancelled) return;
        setPage({
          kind: result.kind,
          src:
            result.kind === 'url'
              ? (normalizeSafeLinkHref(result.src) ?? '')
              : resolveArtifactUrl(result.src, canvasId),
          snapshot: result.kind === 'html' && result.snapshot === true,
        });
      },
      () => {
        if (!cancelled) setFailure('page');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [canvasId, nodeId, remoteHref, retryAttempt]);

  const pageSrc = page?.src;
  const snapshot = page?.snapshot;

  if (remoteHref && !reader) return <>{fallback}</>;

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
        {remoteHref && reader ? (
          <div
            className={`bg-surface h-full overflow-x-hidden overflow-y-auto ${interactive ? 'nodrag nopan nowheel' : 'pointer-events-none'}`}
            inert={!interactive}
            data-web-reader
          >
            <ReaderFrame html={reader} title={t('node.readerView')} />
          </div>
        ) : failed ? (
          <div className="text-fg-subtle flex h-full flex-col items-center justify-center gap-2 text-sm">
            <span role="status">
              {t(
                failure === 'interactive'
                  ? 'node.failedInitializeInteractiveView'
                  : 'node.failedLoadPage',
              )}
            </span>
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              className="nodrag nopan"
              onClick={(event) => {
                event.stopPropagation();
                setFailure(null);
                setRetryAttempt((attempt) => attempt + 1);
              }}
            >
              {t('messages.retry')}
            </Button>
          </div>
        ) : pageSrc ? (
          <iframe
            key={`${pageSrc}:${retryAttempt}`}
            ref={iframeRef}
            src={pageSrc}
            title={t('node.livePage')}
            // Never grant same-origin, including after redirects.
            sandbox={snapshot ? '' : 'allow-scripts allow-forms'}
            referrerPolicy="no-referrer"
            inert={!interactive}
            onLoad={bridge.onLoad}
            onErrorCapture={() => setFailure('page')}
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
