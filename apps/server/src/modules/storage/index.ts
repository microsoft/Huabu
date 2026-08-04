/**
 * Storage module — public entry point.
 *
 * Exports only. Three layers meet here and nothing else may reach across
 * them (docs/proposals/multi-backend-storage.md §12.2.1):
 *
 *   - `ports/`          backend-neutral contracts and their reusable suites
 *   - `backends/disk/`  the Disk adapters implementing those ports
 *   - `compatibility/`  the current synchronous application surface
 *
 * Application code imports from here, never from `backends/`.
 */

// ─── Compatibility surface (current application API) ───────────────────────

export {
  CanvasStore,
  createCanvas,
  deleteCanvas,
  forgetCanvasStore,
  getCanvasStore,
  listCanvases,
  listCanvasSummaries,
  resetStorageCache,
} from './compatibility/canvas.js';
export type {
  NodeContentSummary,
  RenameResult,
  RenameSelfResult,
} from './compatibility/canvas.js';

export {
  getWorldCanvasId,
  isWorldCanvasId,
  requireWorldCanvasId,
} from '../workspace/disk/canvas-dirs.js';
export {
  withCanvasMutex,
  updateNode,
  applyNodeUpdate,
} from '../canvas/write-coordinator.js';
export type {
  UpdateNodeOptions,
  UpdateNodeOutcome,
} from '../canvas/write-coordinator.js';
export type {
  CanvasEvent,
  CanvasFile,
  DeltaLogEntry,
  NodeContent,
} from '../canvas/persistence-types.js';

// ─── Storage ports and composition ─────────────────────────────────────────

export {
  canvasBlobs,
  createStorage,
  getBlobStore,
  getStorage,
  getStructuredStore,
  initStorage,
  setStorageForTesting,
  storageHealth,
} from './storage.js';
export type { Storage } from './storage.js';
export {
  parseStorageProfile,
  StorageProfileError,
  validateStorageProfile,
} from './profile.js';
export type { StorageProfile } from './profile.js';
export { BlobNameError, normalizeBlobName } from './ports/blob.js';
export type {
  BlobBackendKind,
  BlobInfo,
  BlobLease,
  BlobRange,
  BlobRead,
  BlobScope,
  BlobScopeRef,
  BlobStore,
} from './ports/blob.js';
export type { StorageHealth } from './ports/common.js';
export type {
  SpaceHandle,
  StructuredBackendKind,
  StructuredStore,
} from './ports/structured.js';
