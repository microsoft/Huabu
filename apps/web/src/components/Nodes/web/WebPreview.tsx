import { useEffect, useMemo, useRef, useState } from 'react';

import useCanvasStore from '../../../store/canvasStore.ts';
import { LoadingState } from '../../Common/LoadingState';

import type { PreviewComponentProps } from '../note/NotePreview';

import { getWebReader } from '@/api/web';

export const WebPreview = ({ id, data }: PreviewComponentProps) => {
  const src = typeof data.src === 'string' ? data.src : '';
  // The reader artifact only exists after preprocessing has persisted it.
  // `data.content` is hydrated from the per-node .md frontmatter on read,
  // so its presence is a reliable "reader is ready" signal.
  const hasIngestedContent =
    typeof data.content === 'string' && data.content.length > 0;
  const canvasId = useCanvasStore((s) => s.canvasId);

  const [readerHtml, setReaderHtml] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iframeHeight, setIframeHeight] = useState<number | null>(null);
  const iframeIdRef = useRef(
    `web-preview-${Math.random().toString(36).slice(2)}`,
  );

  useEffect(() => {
    if (!src) {
      setReaderHtml('');
      setError(null);
      setLoading(false);
      return;
    }

    if (!id || !hasIngestedContent) {
      setReaderHtml('');
      setError(null);
      setLoading(false);
      return;
    }

    if (!canvasId) {
      setReaderHtml('');
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setIframeHeight(null);

    void (async () => {
      try {
        const result = await getWebReader({ canvasId, nodeId: id });
        if (cancelled) return;
        setReaderHtml(result.html);
      } catch (e) {
        if (cancelled) return;
        setReaderHtml('');
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src, id, hasIngestedContent, canvasId]);

  // Listen for height reports from the iframe to auto-size it
  useEffect(() => {
    const id = iframeIdRef.current;
    const handleMessage = (e: MessageEvent) => {
      if (
        e.data?.type === 'web-preview-resize' &&
        e.data?.id === id &&
        typeof e.data.height === 'number'
      ) {
        setIframeHeight(e.data.height);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const srcDoc = useMemo(() => {
    if (!readerHtml) return '';
    const id = iframeIdRef.current;
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
        var id = ${JSON.stringify(id)};
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

  return (
    <div className="relative flex h-full flex-col">
      {!src ? (
        <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
          Invalid URL
        </div>
      ) : loading ? (
        <LoadingState message="Loading..." />
      ) : error ? (
        <div className="text-fg-subtle flex h-full w-full flex-col items-center justify-center gap-2 text-sm">
          <div>Failed to load reader view</div>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-info text-xs font-medium"
          >
            Open in browser
          </a>
        </div>
      ) : (
        <div className="custom-scrollbar bg-surface flex-1 overflow-x-hidden overflow-y-auto p-1">
          <iframe
            className="nodrag w-full border-0"
            style={{ height: iframeHeight ? `${iframeHeight}px` : '100%' }}
            title="Reader View"
            sandbox="allow-popups allow-scripts"
            srcDoc={srcDoc}
            scrolling="no"
          />
        </div>
      )}
    </div>
  );
};
