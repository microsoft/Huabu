// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiUrl } from './_client';
import { routes } from './_routes';

/** Absolute URL of the canvas real-time sync SSE stream. */
export function canvasSyncStreamUrl(canvasId: string): string {
  return apiUrl(routes.canvasSyncStream(canvasId));
}
