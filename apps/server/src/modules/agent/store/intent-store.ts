// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Intent Store — thin wrapper over the structured intent repository.
 */

import { getStructuredStore } from '../../storage/index.js';

import type { IntentEpisode } from '@huabu/shared';

/**
 * Append (or replace by id) an intent episode for a canvas.
 * No-op when `canvasId` is missing.
 */
export async function logIntentEpisode(
  episode: IntentEpisode,
  canvasId?: string,
): Promise<void> {
  if (!canvasId) return;
  return getStructuredStore().space(canvasId).history.intents.put(episode);
}
