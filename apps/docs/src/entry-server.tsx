// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { prerenderToNodeStream } from 'react-dom/static';
import { StaticRouter } from 'react-router';

import { docsBasePath, routerBasename } from './basePath';
import { DocsApp } from './DocsApp';
import { routeManifest } from './navigation';

export { docsBasePath, routeManifest };

export async function renderRoute(pathname: string): Promise<string> {
  const location = `${routerBasename === '/' ? '' : routerBasename}${pathname}`;
  const errors: unknown[] = [];

  const { prelude } = await prerenderToNodeStream(
    <StaticRouter basename={routerBasename} location={location}>
      <DocsApp />
    </StaticRouter>,
    {
      // Keep every Suspense boundary inline instead of letting React split
      // large content into a streamed chunk with a fallback placeholder.
      progressiveChunkSize: Number.MAX_SAFE_INTEGER,
      onError(error) {
        errors.push(error);
      },
    },
  );

  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk));

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    throw new Error(
      `Failed to prerender ${pathname}: ${errors.length} render error(s).`,
    );
  }

  return Buffer.concat(chunks).toString('utf8');
}
