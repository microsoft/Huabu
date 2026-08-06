// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch, apiUrl } from './_client';
import { routes } from './_routes';

import type {
  ImportExternalNoteRequest,
  ImportExternalNoteResponse,
} from '@huabu/shared';

export function externalStreamUrl(canvasId: string): string {
  return apiUrl(routes.canvasExternalStream(canvasId));
}

export async function importExternalNote(
  canvasId: string,
  request: ImportExternalNoteRequest,
): Promise<ImportExternalNoteResponse> {
  return apiFetch<ImportExternalNoteResponse>(
    routes.canvasExternalImport(canvasId),
    {
      method: 'POST',
      json: request,
      fallbackMessage: 'Failed to import external note',
    },
  );
}
