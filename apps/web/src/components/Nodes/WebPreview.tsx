import { useEffect, useMemo, useState } from 'react';

import { getWebReader } from '@/api/web';

import type { PreviewComponentProps } from './NotePreview';

export const WebPreview = ({ data }: PreviewComponentProps) => {
  const src = typeof data.src === 'string' ? data.src : '';
  const sourceId = typeof data.sourceId === 'string' ? data.sourceId : '';

  const [readerHtml, setReaderHtml] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setReaderHtml('');
      setError(null);
      setLoading(false);
      return;
    }

    if (!sourceId) {
      setReaderHtml('');
      setError('Source not ingested');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await getWebReader({ sourceId });
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
  }, [src, sourceId]);

  const srcDoc = useMemo(() => {
    if (!readerHtml) return '';
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base target="_blank" />
    <style>
      body { margin: 0; padding: 16px; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
      img { max-width: 100%; height: auto; }
      pre { overflow: auto; background: #f5f5f5 /* matches --background light value */; padding: 10px; border-radius: 4px; }
      code { font-family: monospace; }
    </style>
  </head>
  <body>
    ${readerHtml}
  </body>
</html>`;
  }, [readerHtml]);

  return (
    <div className="bg-card flex h-full w-full flex-col p-3">
      <div className="bg-card relative h-full w-full overflow-hidden rounded">
        {!src ? (
          <div className="text-muted-foreground flex h-full w-full items-center justify-center text-sm">
            Invalid URL
          </div>
        ) : loading ? (
          <div className="text-muted-foreground flex h-full w-full items-center justify-center text-sm">
            Loading...
          </div>
        ) : error ? (
          <div className="text-muted-foreground flex h-full w-full flex-col items-center justify-center gap-2 text-sm">
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
          <iframe
            className="nodrag h-full w-full border-0"
            title="Reader View"
            sandbox="allow-popups"
            srcDoc={srcDoc}
          />
        )}
      </div>
    </div>
  );
};
