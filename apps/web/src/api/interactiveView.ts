// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  InteractiveViewActionRequest,
  InteractiveViewActionResponse,
  InteractiveViewResource,
  InteractiveViewRuntimeSnapshot,
  ReplaceInteractiveViewStateRequest,
} from '@huabu/shared';

export function submitInteractiveViewAction(
  canvasId: string,
  nodeId: string,
  actionId: string,
  request: InteractiveViewActionRequest,
): Promise<InteractiveViewActionResponse> {
  return apiFetch<InteractiveViewActionResponse>(
    routes.interactiveViewAction(canvasId, nodeId, actionId),
    {
      method: 'POST',
      json: request,
      fallbackMessage: 'Failed to submit Interactive View action',
    },
  );
}

export function getInteractiveView(
  canvasId: string,
  nodeId: string,
): Promise<InteractiveViewResource> {
  return apiFetch<InteractiveViewResource>(
    routes.interactiveView(canvasId, nodeId),
    { fallbackMessage: 'Failed to load Interactive View' },
  );
}

export function replaceInteractiveViewState(
  canvasId: string,
  nodeId: string,
  request: ReplaceInteractiveViewStateRequest,
): Promise<InteractiveViewResource> {
  return apiFetch<InteractiveViewResource>(
    routes.interactiveViewState(canvasId, nodeId),
    {
      method: 'PUT',
      json: request,
      fallbackMessage: 'Failed to save Interactive View state',
    },
  );
}

export function getInteractiveViewRuntime(
  canvasId: string,
  nodeId: string,
): Promise<InteractiveViewRuntimeSnapshot> {
  return apiFetch<InteractiveViewRuntimeSnapshot>(
    routes.interactiveViewRuntime(canvasId, nodeId),
    { fallbackMessage: 'Failed to refresh Interactive View data' },
  );
}
