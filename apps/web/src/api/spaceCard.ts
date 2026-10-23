// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  RenameSpaceBody,
  RenameSpaceResponse,
  SpaceCardQueryResponse,
} from '@huabu/shared';

export function querySpaceCards(canvasIds: string[], signal: AbortSignal) {
  return apiFetch<SpaceCardQueryResponse>(routes.spaceCardQuery, {
    method: 'POST',
    json: { canvasIds },
    signal,
    cache: 'no-store',
    fallbackMessage: 'Unable to load Space activity',
  });
}

export function renameSpace(canvasId: string, body: RenameSpaceBody) {
  return apiFetch<RenameSpaceResponse>(routes.spaceTitle(canvasId), {
    method: 'PATCH',
    json: body,
    fallbackMessage: 'Unable to rename Space',
  });
}
