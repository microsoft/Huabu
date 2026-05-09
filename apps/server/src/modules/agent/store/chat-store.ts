/**
 * Chat Store — thin wrapper over `CanvasStore` for chat history I/O.
 *
 * Persists pi-ai `Context` objects per canvas under
 * `<canvasId>/.history/chat/<threadId>.json`.
 */

import { getCanvasStore } from '../../storage/index.js';

import type { Context } from '@earendil-works/pi-ai';

/**
 * Save a pi-ai Context for a given thread on a canvas.
 * No-op when `canvasId` is missing.
 */
export function saveContext(
  threadId: string,
  context: Context,
  canvasId?: string,
): void {
  if (!canvasId) return;
  getCanvasStore(canvasId).writeChat(threadId, context);
}

/**
 * Load a pi-ai Context for a given thread on a canvas.
 * Returns null if no context exists or `canvasId` is missing.
 */
export function loadContext(
  threadId: string,
  canvasId?: string,
): Context | null {
  if (!canvasId) return null;
  return getCanvasStore(canvasId).readChat(threadId);
}

/**
 * Find the most recently modified thread on a canvas.
 */
export function loadLatestContext(
  canvasId?: string,
): { threadId: string; context: Context } | null {
  if (!canvasId) return null;
  return getCanvasStore(canvasId).loadLatestChat();
}
