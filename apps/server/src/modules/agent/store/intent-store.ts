// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Intent Store — thin wrapper over the structured storage port for intent
 * log I/O.
 *
 * Persists `IntentEpisode` arrays per canvas under
 * `<canvasId>/.history/intent.json`.
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
  await getStructuredStore().space(canvasId).intents.upsert(episode);
}
