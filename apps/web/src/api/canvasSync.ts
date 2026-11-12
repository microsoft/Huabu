// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiUrl } from './_client';
import { routes } from './_routes';

/**
 * Absolute URL of the canvas real-time sync SSE stream. `pageId` tells the
 * server which page this is, so it is not sent its own presence.
 */
export function canvasSyncStreamUrl(canvasId: string, pageId: string): string {
  return apiUrl(routes.canvasSyncStream(canvasId, pageId));
}
