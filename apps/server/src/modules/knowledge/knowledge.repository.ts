import { FileKnowledgeRepository } from './file.repository.js';
import { getSourcesDir } from '../workspace.js';

import type { IKnowledgeRepository } from './knowledge.interface.js';

/**
 * Singleton instance for the file-based knowledge repository.
 * Lazily created on first access.
 */
let repositoryInstance: IKnowledgeRepository | null = null;

/**
 * Get or initialise the knowledge repository singleton.
 * Always uses the file-based FileKnowledgeRepository backed by the
 * workspace sources directory.
 */
export async function getKnowledgeRepository(): Promise<IKnowledgeRepository> {
  if (!repositoryInstance) {
    repositoryInstance = new FileKnowledgeRepository(getSourcesDir());
  }
  return repositoryInstance;
}

/**
 * Reset the cached repository singleton.
 * Must be called whenever the workspace path changes so that the next call
 * to getKnowledgeRepository() creates a fresh instance pointing at the
 * new sources directory.
 */
export function resetKnowledgeRepository(): void {
  repositoryInstance = null;
}
