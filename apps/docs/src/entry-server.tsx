// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { PassThrough } from 'node:stream';

import { renderToPipeableStream } from 'react-dom/server';
import { StaticRouter } from 'react-router';

import { docsBasePath, routerBasename } from './basePath';
import { DocsApp } from './DocsApp';
import { routeManifest } from './navigation';

export { docsBasePath, routeManifest };

export function renderRoute(pathname: string): Promise<string> {
  const location = `${routerBasename === '/' ? '' : routerBasename}${pathname}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const output = new PassThrough();
    const chunks: Buffer[] = [];

    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    output.on('end', () => {
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    output.on('error', reject);

    const stream = renderToPipeableStream(
      <StaticRouter basename={routerBasename} location={location}>
        <DocsApp />
      </StaticRouter>,
      {
        onAllReady() {
          stream.pipe(output);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          if (!settled) console.error(error);
        },
      },
    );
  });
}
