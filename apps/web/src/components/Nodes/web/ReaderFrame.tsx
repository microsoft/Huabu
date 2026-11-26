// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The reader view of a web page: the text the Server extracted when it
 * fetched the page, as sanitized HTML. Nothing of the original site runs.
 *
 * The frame grows to the height of its content, so the caller's container is
 * what scrolls.
 */
export function ReaderFrame({
  html,
  title,
  className = '',
}: {
  html: string;
  title: string;
  className?: string;
}) {
  const channelId = useRef(
    `web-preview-${Math.random().toString(36).slice(2)}`,
  ).current;
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (
        e.data?.type === 'web-preview-resize' &&
        e.data?.id === channelId &&
        typeof e.data.height === 'number'
      ) {
        setHeight(e.data.height);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [channelId]);

  const srcDoc = useMemo(
    () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base target="_blank" />
    <style>
      html { color-scheme: light; }
      html, body { margin: 0; padding: 0; overflow: hidden; }
      body { padding: 16px; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
      img { max-width: 100%; height: auto; }
      pre { overflow: auto; background: var(--bg-default); padding: 10px; border-radius: 4px; }
      code { font-family: monospace; }
    </style>
  </head>
  <body>
    ${html}
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
</html>`,
    [html, channelId],
  );

  return (
    <iframe
      className={`nodrag w-full border-0 ${className}`}
      style={{
        colorScheme: 'light',
        height: height ? `${height}px` : '100%',
      }}
      title={title}
      sandbox="allow-popups allow-scripts"
      srcDoc={srcDoc}
      scrolling="no"
    />
  );
}
