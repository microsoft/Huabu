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
 *   - `compatibility/`  the current synchronous application surface
 *
 * Application code imports from here, never from `backends/`.
 */

// ─── Compatibility surface (current application API) ───────────────────────

export {
  CanvasStore,
  forgetCanvasStore,
  getCanvasStore,
  resetStorageCache,
} from './compatibility/canvas.js';
export type { RenameResult, RenameSelfResult } from './compatibility/canvas.js';

export {
  getWorldCanvasId,
  isWorldCanvasId,
  requireWorldCanvasId,
} from './backends/disk/canvas-dirs.js';

/**
 * Materialization-tier capabilities, re-exported so consumers that need a
 * real Space directory reach them through the facade rather than naming a
 * backend (§12.5.4).
 *
 * Each is Disk-shaped by nature, not by accident: releasing directory handles
 * exists so Windows can rename a Space folder, and the World bootstrap writes
 * one. A profile that does not materialize Spaces has nothing for either to
 * do, which is the gate that keeps them off the portable surface.
 */
export {
  registerSpaceDirHandleOwner,
  withSpaceDirHandlesReleased,
} from './backends/disk/space-dir-handles.js';
export type { SpaceDirHandleOwner } from './backends/disk/space-dir-handles.js';
export { ensureWorldCanvasOnDisk } from './backends/disk/world-canvas.js';
/**
 * Workspace adoption, split out from the repository on purpose: the isolated
 * preparation child creates the manifest as part of the blocking filesystem
 * work it exists to contain, while registry membership stays a Server-process
 * decision with exactly one writer.
 */
export {
  ensureWorkspaceManifestOnDisk,
  workspaceIdentityOnDisk,
} from './backends/disk/workspace-repository.js';
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
  adoptWorkspaceDirectory,
  composeStorage,
  createSpace,
  createStorage,
  deleteSpace,
  getBlobStore,
  getStorage,
  getStructuredStore,
  getWorkspaceRepository,
  hasWorkspaceRegistry,
  initStorage,
  setStorageForTesting,
  space,
  stageSpaceImport,
  storageHealth,
  workspaceAtDirectory,
  workspaceDirectory,
} from './storage.js';
export type { Space, SpaceDeleteOutcome, Storage } from './storage.js';
export type { DiskSpaceTree } from './backends/disk/space-tree.js';
export type { DiskSpaceImport } from './backends/disk/space-import.js';
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
  WorkspaceHandle,
  WorkspaceRepository,
} from './ports/workspace.js';
export type {
  NewCanvasEvent,
  NodeDeleteResult,
  NodePutInput,
  NodePutResult,
  NodeSnapshot,
  NodeStreamOptions,
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
