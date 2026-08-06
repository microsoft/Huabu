// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  WebLookupQuery,
  WebPageResponse,
  WebPreviewResponse,
  WebReaderResponse,
} from '@huabu/shared';

export type {
  WebLookupQuery,
  WebPageResponse,
  WebPreviewResponse,
  WebReaderResponse,
};

export async function getWebPreview(
  query: WebLookupQuery,
): Promise<WebPreviewResponse> {
  return apiFetch<WebPreviewResponse>(
    routes.webPreview(query.canvasId, query.nodeId),
    { fallbackMessage: 'Failed to fetch web preview' },
  );
}

export async function getWebReader(
  query: WebLookupQuery,
): Promise<WebReaderResponse> {
  return apiFetch<WebReaderResponse>(
    routes.webReader(query.canvasId, query.nodeId),
    { fallbackMessage: 'Failed to fetch web reader content' },
  );
}

export async function getWebPage(
  query: WebLookupQuery,
): Promise<WebPageResponse> {
  return apiFetch<WebPageResponse>(
    routes.webPage(query.canvasId, query.nodeId),
    { fallbackMessage: 'Failed to resolve web page source' },
  );
}
