import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  WebLookupQuery,
  WebPreviewResponse,
  WebReaderResponse,
} from '@sediment/shared';

export type { WebLookupQuery, WebPreviewResponse, WebReaderResponse };

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
