import { ArrowUpRight, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { resolveArtifactUrl } from '@/api/artifact';
import { getWebPage, getWebReader } from '@/api/web';

import { isElectron } from '../../../hooks/useElectron.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import { Button } from '../../Common/Button';
import { LoadingState } from '../../Common/LoadingState';
import { usePreviewHeaderSlot } from '../PreviewHeaderSlot';

import type { PreviewComponentProps } from '../note/NotePreview';

type ViewMode = 'live' | 'reader';

const REMOTE_URL_RE = /^https?:\/\//i;

/**
 * How long the corner "Loading…" badge lingers before we dismiss it,
 * regardless of whether the iframe has fired `load`.
 *
 * SPAs commonly delay (or never fire) `load` because every outstanding
 * asset request blocks it. The iframe itself is mounted from the start,
 * so users see the page render progressively underneath the badge —
 * keeping the badge around past this point is just visual noise.
 */
const IFRAME_SPINNER_DISMISS_MS = 1500;

/**
 * Soft deadline used by the plain-browser auto-fallback. When live mode
 * has been visible for this long without the iframe firing `load` AND
 * the reader view is already prepared, we silently swap to reader. This
 * catches sites that send `X-Frame-Options` we couldn't detect server-
 * side (e.g. when the response was already cached without us).
 *
 * Electron ignores this — the main process strips the headers, so the
 * iframe always loads.
 */
const LIVE_LOAD_TIMEOUT_MS = 3500;

export const WebPreview = ({ id, data }: PreviewComponentProps) => {
  const src = typeof data.src === 'string' ? data.src : '';
  const canvasId = useCanvasStore((s) => s.canvasId);

  // The reader artifact only exists after preprocessing has persisted it.
  // `data.content` is hydrated from the per-node .md frontmatter on read,
  // so its presence is a reliable "preprocessing finished" signal.
  const hasIngestedContent =
    typeof data.content === 'string' && data.content.length > 0;

  // ── State ────────────────────────────────────────────────────────
  const [mode, setMode] = useState<ViewMode>('live');
  const [pageSrc, setPageSrc] = useState<string>('');
  const [pageKind, setPageKind] = useState<'url' | 'html' | null>(null);
  const [pageEmbeddable, setPageEmbeddable] = useState<boolean | undefined>(
    undefined,
  );
  const [readerHtml, setReaderHtml] = useState<string>('');
  const [loadingPage, setLoadingPage] = useState(false);
  const [loadingReader, setLoadingReader] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const [iframeBumpKey, setIframeBumpKey] = useState(0);

  // Electron is detected once at mount — it does not change at runtime.
  // Inside the desktop shell the main process strips X-Frame-Options /
  // frame-ancestors, so live always works regardless of the server-side
  // embeddable verdict.
  const inElectron = useMemo(() => isElectron(), []);

  // ── Load reader HTML (cheap; fetched up-front so the fallback flip
  //    has something to show immediately when live fails) ───────────
  useEffect(() => {
    if (!src || !id || !canvasId || !hasIngestedContent) {
      setReaderHtml('');
      setReaderError(null);
      setLoadingReader(false);
      return;
    }

    let cancelled = false;
    setLoadingReader(true);
    setReaderError(null);

    void (async () => {
      try {
        const result = await getWebReader({ canvasId, nodeId: id });
        if (cancelled) return;
        setReaderHtml(result.html);
      } catch (error) {
        if (cancelled) return;
        setReaderHtml('');
        setReaderError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setLoadingReader(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src, id, canvasId, hasIngestedContent]);

  // ── Resolve the live page target via the server's `/web/page` endpoint ─
  useEffect(() => {
    if (!src || !id || !canvasId) {
      setPageSrc('');
      setPageKind(null);
      setPageEmbeddable(undefined);
      setPageError(null);
      setLoadingPage(false);
      return;
    }

    let cancelled = false;
    setLoadingPage(true);
    setPageError(null);

    void (async () => {
      try {
        const result = await getWebPage({ canvasId, nodeId: id });
        if (cancelled) return;
        const resolved =
          result.kind === 'url'
            ? result.src
            : resolveArtifactUrl(result.src, canvasId);
        setPageSrc(resolved);
        setPageKind(result.kind);
        setPageEmbeddable(result.embeddable);
      } catch (error) {
        if (cancelled) return;
        setPageSrc('');
        setPageKind(null);
        setPageEmbeddable(undefined);
        setPageError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setLoadingPage(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src, id, canvasId]);

  // ── Decide which mode to start in once the page metadata arrives ───
  //
  // Electron: always start live — the main process strips XFO/CSP so
  // every site loads. The embeddable verdict from the server is
  // irrelevant.
  // Plain browser: respect the server-side verdict. `false` → start in
  // reader straight away (saves the user staring at a blank iframe).
  // `true` or `undefined` → try live first; the load-timeout below will
  // silently flip to reader if it never resolves.
  useEffect(() => {
    if (!pageSrc) return;
    if (!inElectron && pageEmbeddable === false) {
      setMode('reader');
    } else {
      setMode('live');
    }
  }, [pageSrc, pageEmbeddable, inElectron]);

  // ── Manage the loading badge + auto-fall back to reader ────────────
  //
  // SPAs are notorious for delaying (or never firing) `load` because every
  // outstanding asset request blocks it. We can't gate the iframe visibility
  // on `onLoad` — it would leave the user staring at a hidden iframe even
  // after the page has rendered. So we do two things:
  //
  //   1. A short "spinner deadline": dismiss the corner badge regardless
  //      so it doesn't linger forever on slow-but-working pages.
  //   2. A longer "reader fallback deadline": when the iframe still
  //      hasn't fired `load` AND the reader view is ready, silently flip
  //      to reader. Skipped inside Electron — there the iframe is
  //      authoritative.
  const iframeSpinnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const iframeFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Mirror the latest `iframeReady` into a ref so the fallback timer
  // can read it without re-binding the effect every transition.
  const iframeReadyRef = useRef(iframeReady);
  iframeReadyRef.current = iframeReady;
  const readerHtmlRef = useRef(readerHtml);
  readerHtmlRef.current = readerHtml;

  useEffect(() => {
    setIframeReady(false);
    if (iframeSpinnerTimerRef.current)
      clearTimeout(iframeSpinnerTimerRef.current);
    if (iframeFallbackTimerRef.current)
      clearTimeout(iframeFallbackTimerRef.current);

    if (mode !== 'live' || !pageSrc) return;

    iframeSpinnerTimerRef.current = setTimeout(() => {
      setIframeReady(true);
      iframeSpinnerTimerRef.current = null;
    }, IFRAME_SPINNER_DISMISS_MS);

    // Plain browser only: arm the silent flip to reader if the iframe
    // never makes it to `load` within the window. Electron strips the
    // blocking headers, so the iframe always loads — no need to bail.
    if (!inElectron) {
      iframeFallbackTimerRef.current = setTimeout(() => {
        if (!iframeReadyRef.current && readerHtmlRef.current) {
          setMode('reader');
        }
        iframeFallbackTimerRef.current = null;
      }, LIVE_LOAD_TIMEOUT_MS);
    }

    return () => {
      if (iframeSpinnerTimerRef.current)
        clearTimeout(iframeSpinnerTimerRef.current);
      if (iframeFallbackTimerRef.current)
        clearTimeout(iframeFallbackTimerRef.current);
    };
  }, [mode, pageSrc, iframeBumpKey, inElectron]);

  // URL we'd open in the system browser when the user clicks
  // "Open externally". Only meaningful when the node points at a real
  // remote URL — `data:` URLs and uploaded HTML artifacts are both
  // self-contained / same-origin, so the "open elsewhere" target would
  // either be the same inline HTML the iframe already renders or a
  // /api/canvas/.../artifact/... URL that has no meaning outside the
  // app. Hide the button rather than expose a dead-end link.
  const externalHref = useMemo(
    () => (REMOTE_URL_RE.test(src) ? src : ''),
    [src],
  );

  const handleReload = useCallback(() => {
    setIframeReady(false);
    // If we previously fell back to reader, this also re-arms a live
    // attempt — the user explicitly asked for a refresh, treat it as a
    // chance to retry the live site.
    setMode('live');
    setIframeBumpKey((n) => n + 1);
  }, []);

  // ── Reader-view iframe srcDoc (auto-resizes via postMessage) ─────
  const readerIframeId = useRef(
    `web-preview-${Math.random().toString(36).slice(2)}`,
  );
  const [readerHeight, setReaderHeight] = useState<number | null>(null);
  useEffect(() => {
    const channelId = readerIframeId.current;
    const handleMessage = (e: MessageEvent) => {
      if (
        e.data?.type === 'web-preview-resize' &&
        e.data?.id === channelId &&
        typeof e.data.height === 'number'
      ) {
        setReaderHeight(e.data.height);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const readerSrcDoc = useMemo(() => {
    if (!readerHtml) return '';
    const channelId = readerIframeId.current;
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base target="_blank" />
    <style>
      html, body { margin: 0; padding: 0; overflow: hidden; }
      body { padding: 16px; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
      img { max-width: 100%; height: auto; }
      pre { overflow: auto; background: var(--bg-default); padding: 10px; border-radius: 4px; }
      code { font-family: monospace; }
    </style>
  </head>
  <body>
    ${readerHtml}
    <script>
      (function() {
        var id = ${JSON.stringify(channelId)};
        function reportHeight() {
          window.parent.postMessage(
            { type: 'web-preview-resize', id: id, height: document.body.scrollHeight },
            '*'
          );
        }
        window.addEventListener('load', reportHeight);
        if (window.ResizeObserver) {
          new ResizeObserver(reportHeight).observe(document.body);
        }
      })();
    </script>
  </body>
</html>`;
  }, [readerHtml]);

  // Host header slot — rendered by `ExpandedNodePanel`. Same pattern as
  // NotePreview's edit-mode toggle: portal our action buttons up into
  // the shared header so they sit next to the universal Split view /
  // Close buttons instead of floating over the page content. Hook is
  // declared up here (before any early return) to satisfy React's
  // rules-of-hooks.
  const { el: headerSlotEl } = usePreviewHeaderSlot();

  // ── Render ───────────────────────────────────────────────────────
  if (!src) {
    return (
      <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
        Invalid URL
      </div>
    );
  }

  const showLive = mode === 'live';

  const headerActions =
    pageSrc || externalHref ? (
      <>
        {pageSrc ? (
          <Button
            variant="ghost"
            tone="neutral"
            size="sm"
            iconOnly
            title="Reload"
            tooltipPlacement="bottom"
            aria-label="Reload page"
            onClick={handleReload}
          >
            <RotateCw />
          </Button>
        ) : null}
        {externalHref ? (
          <Button
            variant="ghost"
            tone="neutral"
            size="sm"
            iconOnly
            title="Open externally"
            tooltipPlacement="bottom"
            aria-label="Open page in external browser"
            onClick={() => window.open(externalHref, '_blank', 'noopener')}
          >
            <ArrowUpRight />
          </Button>
        ) : null}
      </>
    ) : null;

  return (
    <div className="bg-surface relative flex h-full flex-col">
      {headerSlotEl && headerActions
        ? createPortal(headerActions, headerSlotEl)
        : null}
      <div className="relative h-full flex-1 overflow-hidden">
        {showLive ? (
          loadingPage ? (
            <LoadingState message="Loading..." />
          ) : pageError ? (
            <div className="text-fg-subtle flex h-full w-full flex-col items-center justify-center gap-2 text-sm">
              <div>Failed to load page</div>
              <p className="text-xs">{pageError}</p>
            </div>
          ) : pageSrc ? (
            <>
              {/* Iframe is ALWAYS mounted and visible — never hidden under an
                  overlay. SPA pages routinely take several seconds to fire
                  the `load` event (every async asset blocks it); hiding the
                  iframe until `load` would leave the user staring at a blank
                  panel even after the page has fully rendered. Instead we
                  show a tiny corner spinner that dismisses on `load` OR
                  after the spinner deadline. */}
              <iframe
                key={`${pageSrc}-${iframeBumpKey}`}
                src={pageSrc}
                // Full interactivity in the Preview panel.
                //  - `allow-scripts`         JS-heavy SPAs need to boot.
                //  - `allow-forms`           login forms, search, etc.
                //  - `allow-popups`          links with target=_blank.
                //  - `allow-same-origin`     enabled for remote URLs so
                //                            the page can read its own
                //                            cookies / storage; OMITTED
                //                            for HTML artifacts since the
                //                            artifact URL is same-origin
                //                            with the host app — granting
                //                            `same-origin` there would
                //                            give an attacker-controlled
                //                            HTML upload access to our
                //                            cookies. The sandbox is
                //                            sufficient for displaying
                //                            uploaded content.
                sandbox={
                  pageKind === 'url'
                    ? 'allow-scripts allow-forms allow-popups allow-same-origin'
                    : 'allow-scripts allow-forms allow-popups'
                }
                referrerPolicy="no-referrer"
                title="Live page"
                className="bg-surface block h-full w-full border-0"
                onLoad={() => setIframeReady(true)}
              />
              {!iframeReady ? (
                <div className="bg-bg-default/90 pointer-events-none absolute top-2 left-2 z-10 flex items-center gap-1.5 rounded-full px-2 py-1 shadow-sm backdrop-blur">
                  <span className="text-fg-subtle inline-block h-2 w-2 animate-pulse rounded-full bg-current" />
                  <span className="text-fg-muted text-xs">Loading…</span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
              No source
            </div>
          )
        ) : loadingReader ? (
          <LoadingState message="Loading..." />
        ) : readerError ? (
          <div className="text-fg-subtle flex h-full w-full flex-col items-center justify-center gap-2 text-sm">
            <div>Failed to load reader view</div>
            <p className="text-xs">{readerError}</p>
          </div>
        ) : readerHtml ? (
          <div className="custom-scrollbar bg-surface h-full overflow-x-hidden overflow-y-auto p-1">
            <iframe
              className="nodrag w-full border-0"
              style={{ height: readerHeight ? `${readerHeight}px` : '100%' }}
              title="Reader View"
              sandbox="allow-popups allow-scripts"
              srcDoc={readerSrcDoc}
              scrolling="no"
            />
          </div>
        ) : (
          <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
            Reader view not ready
          </div>
        )}
      </div>
    </div>
  );
};
