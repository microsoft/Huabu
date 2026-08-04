/**
 * Disk implementation of the structured port.
 *
 * Delegates to the existing `CanvasStore` instance cache, so this adds a
 * named boundary without changing how Space records are read or written.
 */

import { getCanvasStore } from './legacy/canvas-store-cache.js';

import type { StorageHealth } from '../../ports/common.js';
import type { SpaceHandle, StructuredStore } from '../../ports/structured.js';

export class DiskStructuredStore implements StructuredStore {
  readonly kind = 'disk' as const;

  async init(): Promise<void> {
    // The workspace directory is prepared by `workspace-prepare.ts`; Space
    // directories are created on demand by `createCanvas`.
  }

  async health(): Promise<StorageHealth> {
    return { ok: true, kind: this.kind };
  }

  async close(): Promise<void> {}

  space(canvasId: string): SpaceHandle {
    return getCanvasStore(canvasId);
  }
}
