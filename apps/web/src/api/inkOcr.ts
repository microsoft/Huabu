// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type { InkOcrConfig, InkOcrConfigUpdate } from '@huabu/shared';

export function getInkOcrConfig(): Promise<InkOcrConfig> {
  return apiFetch<InkOcrConfig>(routes.inkOcrConfig, {
    fallbackMessage: 'Failed to load handwriting recognition settings',
  });
}

export function putInkOcrConfig(
  update: InkOcrConfigUpdate,
): Promise<InkOcrConfig> {
  return apiFetch<InkOcrConfig>(routes.inkOcrConfig, {
    method: 'PUT',
    json: update,
    fallbackMessage: 'Failed to save handwriting recognition settings',
  });
}
