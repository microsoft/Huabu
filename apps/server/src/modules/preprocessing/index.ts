/**
 * Preprocessing Module — Public Exports
 */

import { getKnowledgeRepository } from '../knowledge/knowledge.repository.js';
import { getArtifactsDir } from '../workspace.js';
import { PreprocessDispatcher } from './dispatcher.js';

export { PreprocessDispatcher } from './dispatcher.js';
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
 * Uses the current workspace knowledge repository and artifacts directory.
 */
export async function getPreprocessDispatcher(): Promise<PreprocessDispatcher> {
  if (!dispatcherInstance) {
    const repository = await getKnowledgeRepository();
    dispatcherInstance = new PreprocessDispatcher(
      repository,
      getArtifactsDir(),
    );
  }
  return dispatcherInstance;
}

/**
 * Reset the cached dispatcher singleton.
 * Must be called whenever the workspace path changes.
 */
export function resetPreprocessDispatcher(): void {
  dispatcherInstance = null;
}
