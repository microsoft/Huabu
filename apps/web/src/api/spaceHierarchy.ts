// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  CreateChildSpaceBody,
  DeleteSpaceTreePreview,
  DeleteSpaceTreeResponse,
  SpaceHierarchyResponse,
  SpaceParentBody,
} from '@huabu/shared';

export function createChildSpace(canvasId: string, body: CreateChildSpaceBody) {
  return apiFetch<SpaceHierarchyResponse>(routes.canvasChildren(canvasId), {
    method: 'POST',
    json: body,
    fallbackMessage: 'Could not create child Space',
  });
}

export function setSpaceParent(canvasId: string, body: SpaceParentBody) {
  return apiFetch<SpaceHierarchyResponse>(routes.canvasParent(canvasId), {
    method: 'PATCH',
    json: body,
    fallbackMessage: 'Could not move Space',
  });
}

export function getSpaceDeletionPreview(canvasId: string) {
  return apiFetch<DeleteSpaceTreePreview>(
    routes.canvasDeletionPreview(canvasId),
    {
      fallbackMessage: 'Could not load deletion preview',
    },
  );
}

export function deleteSpaceTree(canvasId: string, token: string) {
  return apiFetch<DeleteSpaceTreeResponse>(routes.canvasDeleteTree(canvasId), {
    method: 'POST',
    json: { token },
    fallbackMessage: 'Could not delete Space subtree',
  });
}
