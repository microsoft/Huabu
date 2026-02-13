import { API_CONFIG } from '../config/api';

import type {
  WebLookupQuery,
  WebPreviewResponse,
  WebReaderResponse,
} from '@sediment/shared';

export type { WebLookupQuery, WebPreviewResponse, WebReaderResponse };

export async function getWebPreview(
  query: WebLookupQuery,
): Promise<WebPreviewResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set('sourceId', query.sourceId);

  const response = await fetch(
    `${API_CONFIG.API_URL}/web/preview?${searchParams.toString()}`,
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch web preview: ${response.statusText}`);
  }

  return (await response.json()) as WebPreviewResponse;
}

export async function getWebReader(
  query: WebLookupQuery,
): Promise<WebReaderResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set('sourceId', query.sourceId);

  const response = await fetch(
    `${API_CONFIG.API_URL}/web/reader?${searchParams.toString()}`,
  );

  if (!response.ok) {
    const details = (await response
      .json()
      .catch(() => ({ message: response.statusText }))) as { message?: string };
    throw new Error(details.message || response.statusText);
  }

  return (await response.json()) as WebReaderResponse;
}
