/**
 * Intent Store — thin wrapper over `CanvasStore` for intent log I/O.
 *
 * Persists `IntentEpisode` arrays per canvas under
 * `<canvasId>/.history/intent.json`.
 */

import { getCanvasStore } from '../../storage/index.js';

import type { IntentEpisode } from '@huabu/shared';

/**
 * Append (or replace by id) an intent episode for a canvas.
 * No-op when `canvasId` is missing.
 */
export function logIntentEpisode(
  episode: IntentEpisode,
  canvasId?: string,
): void {
  if (!canvasId) return;
  getCanvasStore(canvasId).upsertIntent(episode);
}
