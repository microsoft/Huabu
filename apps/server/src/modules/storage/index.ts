// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Storage module — public entry point.
 *
 * Exports only. Three layers meet here and nothing else may reach across
 * them (docs/proposals/multi-backend-storage.md §12.2.1):
 *
 *   - `ports/`          backend-neutral contracts and their reusable suites
 *   - `backends/disk/`  the Disk adapters implementing those ports
 *   - `compatibility/`  the residual Disk legacy/test surface
 *
 * Application code imports from here, never from `backends/`.
 */

// ─── Compatibility surface (legacy and adapter tests only) ─────────────────

export {
  CanvasStore,
  forgetCanvasStore,
  getCanvasStore,
  resetStorageCache,
} from './compatibility/canvas.js';
export type { RenameResult, RenameSelfResult } from './compatibility/canvas.js';

/**
 * Disk-only bootstrap retained for the isolated legacy migration worker.
 * Runtime World bootstrap enters through `SpaceRepository.ensureWorld()`.
 */
export { ensureWorldCanvasOnDisk } from './backends/disk/world-canvas.js';
export { withCanvasMutex, updateNode } from '../canvas/write-coordinator.js';
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
  closeStorage,
  createSpace,
  createStorage,
  deleteSpace,
  getBlobStore,
  getStorage,
  getStructuredStore,
  getWorldCanvasId,
  initStorage,
  isWorldCanvasId,
  requireWorldCanvasId,
  setStorageForTesting,
  stageStorageForWorkspace,
  storageHealth,
} from './storage.js';
export type {
  SpaceDeleteOutcome,
  StagedStorageMount,
  Storage,
  StorageRuntime,
} from './storage.js';
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
/**
 * Disk-only capabilities, exported here because they have nowhere portable to
 * live and every consumer must be visible.
 *
 * These are **not** ports and carry no cross-backend promise. Each caller is
 * a reason a non-Disk structured profile is not selectable, and
 * `module-boundaries.test.ts` keeps the exact list so it can only shrink.
 */
export { diskSpaceTree, stageDiskSpaceImport } from './storage.js';
export type {
  DiskSpaceImport,
  DiskSpaceTree,
} from './backends/disk/space-tree.js';
export type { SpaceDirHandleOwner } from './backends/disk/space-dir-handles.js';
export type {
  NewCanvasEvent,
  NodeDeleteResult,
  NodePutInput,
  NodePutResult,
  NodeReadWarning,
  NodeSnapshot,
  SpaceBeginDeleteResult,
  SpaceChanges,
  SpaceCreateInput,
  SpaceCreateResult,
  SpaceDeleteFinishResult,
  SpaceDeleteInput,
  SpaceDeleteSession,
  SpaceEvents,
  SpaceHandle,
  SpaceNodeMutation,
  SpaceNodes,
  SpaceRenameInput,
  SpaceRenameResult,
  SpaceRepository,
  SpaceTaskRuns,
  SpaceTasks,
  SpaceWriteInput,
  SpaceWriteResult,
  StructuredBackendKind,
  StructuredStore,
  TaskRunCompletionResult,
  TaskRunUpdate,
} from './ports/structured.js';
