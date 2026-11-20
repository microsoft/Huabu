// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch, apiUrl } from './_client';
import { routes } from './_routes';

import type {
  CanvasContentChangesResponse,
  CanvasContentPosition,
} from '@huabu/shared';

/**
 * Absolute URL of the canvas real-time sync SSE stream. `pageId` tells the
 * server which page this is, so it is not sent its own presence.
 */
export function canvasSyncStreamUrl(canvasId: string, pageId: string): string {
  return apiUrl(routes.canvasSyncStream(canvasId, pageId));
}

/**
 * The nodes whose content was saved after `since`, the content position the
 * page's nodes are valid from. A content save does not change the Space
 * version, so nothing on the stream says what was saved before it opened.
 */
export function getCanvasContentChanges(
  canvasId: string,
  since: CanvasContentPosition,
): Promise<CanvasContentChangesResponse> {
  return apiFetch<CanvasContentChangesResponse>(
    routes.canvasContentChanges(canvasId, since),
    { fallbackMessage: 'Failed to check for saved content' },
  );
}
