// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What the user can be told about this page's unsent structure edits.
 *
 * Derived from the send queue's status for the open Space. Kept in its own
 * small store so a component can show it without subscribing to the canvas
 * store.
 */

import { create } from 'zustand';

import type { SendQueueStatus } from './sendQueue';

export type CanvasSyncState =
  /** Everything this page changed has been sent. */
  | 'synced'
  /** Changes are being sent. */
  | 'syncing'
  /** The last attempt failed; the page keeps retrying on its own. */
  | 'unsynced'
  /** The retry limit was reached; the user has to choose. */
  | 'error';

export interface CanvasSyncStatus {
  canvasId: string;
  state: CanvasSyncState;
  /** Batches not yet answered by the server. */
  pending: number;
}

export function syncStateOf(status: SendQueueStatus): CanvasSyncState {
  if (status.phase === 'stalled') return 'error';
  if (status.failures > 0) return 'unsynced';
  return status.pending > 0 ? 'syncing' : 'synced';
}

export const useCanvasSyncStatusStore = create<CanvasSyncStatus>(() => ({
  canvasId: '',
  state: 'synced',
  pending: 0,
}));
