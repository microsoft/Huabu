// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiUrl } from './_client';
import { routes } from './_routes';

/**
 * Absolute URL of the canvas real-time sync SSE stream. `pageId` tells the
 * server which page this is, so it is not sent its own presence.
 * `contentSince` is the content position the page last saw on this Space's
 * stream; with it the server's snapshot names the nodes whose content was
 * saved while the page was not connected.
 */
export function canvasSyncStreamUrl(
  canvasId: string,
  pageId: string,
  contentSince?: { epoch: string; seq: number },
): string {
  return apiUrl(routes.canvasSyncStream(canvasId, pageId, contentSince));
}
