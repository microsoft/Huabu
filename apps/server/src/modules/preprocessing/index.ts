// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Preprocessing Module — Public Exports
 */

import { PreprocessDispatcher } from './dispatcher.js';

export {
  capturePreprocessExecutionBaseline,
  PreprocessDispatcher,
} from './dispatcher.js';
export { ProviderManager } from './provider-manager.js';
export { getProfile, profiles } from './profiles.js';
export { runPipeline } from './pipeline.js';

// Re-export stage functions for direct testing
export { inputResolve } from './stages/input-resolve.js';
export { extract } from './stages/extract.js';
export { normalize } from './stages/normalize.js';
export { enrich } from './stages/enrich.js';
export { persist } from './stages/persist.js';
export { project } from './stages/project.js';

// Re-export internal types
export type {
  ResolvedInput,
  ExtractResult,
  NormalizeResult,
  EnrichResult,
  PersistResult,
  PipelineContext,
} from './types.js';

// ---------------------------------------------------------------------------
// Singleton dispatcher
// ---------------------------------------------------------------------------

let dispatcherInstance: PreprocessDispatcher | null = null;

/**
 * Get or create the singleton PreprocessDispatcher.
 * The dispatcher resolves the appropriate `CanvasStore` per request,
 * so it does not need to be reset when the workspace path changes.
 */
export function getPreprocessDispatcher(): PreprocessDispatcher {
  if (!dispatcherInstance) {
    dispatcherInstance = new PreprocessDispatcher();
  }
  return dispatcherInstance;
}

/** Reset the cached dispatcher singleton. */
export function resetPreprocessDispatcher(): void {
  dispatcherInstance = null;
}
